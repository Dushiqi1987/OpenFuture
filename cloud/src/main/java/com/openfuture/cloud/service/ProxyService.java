package com.openfuture.cloud.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.openfuture.cloud.repo.UserRepo;
import com.openfuture.cloud.web.ApiException;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 模型代理：配置了上游就转发（透传 SSE），没配置就返回演示回声。
 * 无论哪种，都会按用量扣费并写流水。
 */
@Service
public class ProxyService {
    private static final Logger log = LoggerFactory.getLogger(ProxyService.class);
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
    private final BillingService billing;
    private final UserRepo users;
    private final String baseUrl;
    private final String apiKey;

    public ProxyService(BillingService billing, UserRepo users,
                        @Value("${openfuture.upstream.base-url:}") String baseUrl,
                        @Value("${openfuture.upstream.api-key:}") String apiKey) {
        this.billing = billing;
        this.users = users;
        this.baseUrl = baseUrl == null ? "" : baseUrl.trim();
        this.apiKey = apiKey == null ? "" : apiKey.trim();
    }

    public Object complete(long userId, String model, Map<String, Object> body,
                           HttpServletResponse response, boolean stream) throws Exception {
        String requestId = "req_" + UUID.randomUUID().toString().replace("-", "");
        String promptText = promptText(body);
        int promptTokens = estimate(promptText);

        if (baseUrl.isEmpty()) {
            return mock(userId, model, body, promptText, promptTokens, requestId, response, stream);
        }
        return forward(userId, model, body, promptText, promptTokens, requestId, response, stream);
    }

    /** 没配上游时的演示回声：证明「鉴权 → 计费 → 返回」整条链路是通的。 */
    private Object mock(long userId, String model, Map<String, Object> body, String promptText, int promptTokens,
                        String requestId, HttpServletResponse response, boolean stream) throws Exception {
        String said = lastUserText(body);
        String reply = "（演示回声）你刚才说：" + (said.isEmpty() ? tail(promptText, 200) : said)
                + "\n\n平台已经按 token 用量扣费。要接真实模型，请在服务端配置 "
                + "OF_UPSTREAM_BASE_URL 和 OF_UPSTREAM_API_KEY 后重启。";
        int completionTokens = estimate(reply);
        long cost = billing.priceOf(model).promptPerM() * promptTokens / 1_000_000L
                + billing.priceOf(model).completionPerM() * completionTokens / 1_000_000L;

        Map<String, Object> usage = usage(promptTokens, completionTokens);
        if (stream) return mockStream(model, reply, usage, response, userId, cost, requestId);
        Map<String, Object> out = completionBody(model, reply, usage);
        chargeQuietly(userId, model, promptTokens, completionTokens, requestId, "PROXY_MOCK");
        return out;
    }

    private Object mockStream(String model, String reply, Map<String, Object> usage,
                              HttpServletResponse response, long userId, long cost,
                              String requestId) throws Exception {
        response.setStatus(200);
        OutputStream out = response.getOutputStream();
        String id = "chatcmpl-" + UUID.randomUUID().toString().substring(0, 8);
        long now = Instant.now().getEpochSecond();
        for (String piece : chunks(reply, 8)) {
            Map<String, Object> delta = Map.of("content", piece);
            Map<String, Object> choice = new LinkedHashMap<>();
            choice.put("index", 0);
            choice.put("delta", delta);
            choice.put("finish_reason", null);
            Map<String, Object> chunk = new LinkedHashMap<>();
            chunk.put("id", id);
            chunk.put("object", "chat.completion.chunk");
            chunk.put("created", now);
            chunk.put("model", model);
            chunk.put("choices", List.of(choice));
            writeSse(out, chunk);
        }
        Map<String, Object> last = new LinkedHashMap<>();
        last.put("id", id);
        last.put("object", "chat.completion.chunk");
        last.put("created", now);
        last.put("model", model);
        last.put("choices", List.of(Map.of("index", 0, "delta", Map.of(), "finish_reason", "stop")));
        last.put("usage", usage);
        writeSse(out, last);
        out.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
        out.flush();
        chargeQuietly(userId, model, (int) usage.get("prompt_tokens"), (int) usage.get("completion_tokens"),
                requestId, "PROXY_MOCK");
        return null;
    }

    /** 转发到 OpenAI 兼容上游；流式时边转发边统计。 */
    private Object forward(long userId, String model, Map<String, Object> body, String promptText,
                           int promptTokens, String requestId, HttpServletResponse response,
                           boolean stream) throws Exception {
        String url = baseUrl.endsWith("/") ? baseUrl + "chat/completions" : baseUrl + "/chat/completions";
        if (baseUrl.endsWith("/v1")) url = baseUrl + "/chat/completions";
        String payload = mapper.writeValueAsString(body);
        HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofMinutes(5))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8));
        if (!apiKey.isEmpty()) rb.header("Authorization", "Bearer " + apiKey);

        HttpResponse<InputStream> up = client.send(rb.build(), HttpResponse.BodyHandlers.ofInputStream());
        if (up.statusCode() >= 400) {
            String err = new String(up.body().readAllBytes(), StandardCharsets.UTF_8);
            log.warn("upstream {} -> {}", up.statusCode(), err);
            throw new ApiException(up.statusCode() >= 500 ? 502 : up.statusCode(), "upstream_error",
                    "上游模型返回错误：" + tail(err, 300));
        }

        if (!stream) {
            String raw = new String(up.body().readAllBytes(), StandardCharsets.UTF_8);
            JsonNode node = mapper.readTree(raw);
            int pt = node.path("usage").path("prompt_tokens").asInt(promptTokens);
            int ct = node.path("usage").path("completion_tokens").asInt(
                    Math.max(1, node.path("choices").path(0).path("message").path("content").asText("").length() / 2));
            BillingService.ChargeResult cr = chargeQuietly(userId, model, pt, ct, requestId, "PROXY");
            Map<String, Object> out = mapper.convertValue(node, Map.class);
            if (cr != null) out.put("openfuture", Map.of("chargedMicros", cr.chargedMicros(),
                    "balanceMicros", cr.balanceMicros(), "balanceYuan", BillingService.yuan(cr.balanceMicros())));
            return out;
        }

        response.setStatus(200);
        OutputStream out = response.getOutputStream();
        StringBuilder reply = new StringBuilder();
        StringBuilder buf = new StringBuilder();
        int ct = 0;
        try (InputStream in = up.body()) {
            byte[] bytes = new byte[8192];
            int n;
            while ((n = in.read(bytes)) != -1) {
                String s = new String(bytes, 0, n, StandardCharsets.UTF_8);
                out.write(s.getBytes(StandardCharsets.UTF_8));
                reply.append(s);
                buf.append(s);
                if (buf.length() > 200_000) buf.setLength(0);
            }
            out.flush();
        }
        ct = extractCompletionTokens(reply.toString());
        if (ct <= 0) ct = estimate(stripSse(reply.toString()));
        chargeQuietly(userId, model, promptTokens, ct, requestId, "PROXY");
        return null;
    }

    private int extractCompletionTokens(String sse) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"completion_tokens\"\\s*:\\s*(\\d+)").matcher(sse);
        int v = 0;
        while (m.find()) v = Integer.parseInt(m.group(1));
        return v;
    }

    private String stripSse(String sse) {
        StringBuilder sb = new StringBuilder();
        for (String line : sse.split("\n")) {
            if (!line.startsWith("data:")) continue;
            String data = line.substring(5).trim();
            if (data.isEmpty() || "[DONE]".equals(data)) continue;
            try {
                JsonNode n = mapper.readTree(data);
                JsonNode c = n.path("choices").path(0).path("delta").path("content");
                if (!c.isMissingNode()) sb.append(c.asText(""));
            } catch (Exception ignored) {
            }
        }
        return sb.toString();
    }

    private BillingService.ChargeResult chargeQuietly(long userId, String model, int pt, int ct,
                                                     String requestId, String source) {
        try {
            return billing.charge(userId, model, pt, ct, requestId, source);
        } catch (ApiException e) {
            log.warn("charge failed uid={} cost model={}: {}", userId, model, e.getMessage());
            return null;
        }
    }

    private Map<String, Object> completionBody(String model, String reply, Map<String, Object> usage) {
        Map<String, Object> msg = Map.of("role", "assistant", "content", reply);
        Map<String, Object> choice = Map.of("index", 0, "message", msg, "finish_reason", "stop");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", "chatcmpl-" + UUID.randomUUID().toString().substring(0, 8));
        out.put("object", "chat.completion");
        out.put("created", Instant.now().getEpochSecond());
        out.put("model", model);
        out.put("choices", List.of(choice));
        out.put("usage", usage);
        return out;
    }

    private Map<String, Object> usage(int prompt, int completion) {
        Map<String, Object> u = new LinkedHashMap<>();
        u.put("prompt_tokens", prompt);
        u.put("completion_tokens", completion);
        u.put("total_tokens", prompt + completion);
        return u;
    }

    private void writeSse(OutputStream out, Map<String, Object> obj) throws Exception {
        out.write(("data: " + mapper.writeValueAsString(obj) + "\n\n").getBytes(StandardCharsets.UTF_8));
    }

    private List<String> chunks(String text, int step) {
        List<String> list = new ArrayList<>();
        for (int i = 0; i < text.length(); i += step) {
            list.add(text.substring(i, Math.min(text.length(), i + step)));
        }
        if (list.isEmpty()) list.add("");
        return list;
    }

    private String promptText(Map<String, Object> body) {
        Object messages = body.get("messages");
        StringBuilder sb = new StringBuilder();
        if (messages instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> m) {
                    sb.append(String.valueOf(m.get("role"))).append(": ")
                            .append(String.valueOf(m.get("content"))).append('\n');
                }
            }
        }
        return sb.toString();
    }

    static int estimate(String text) {
        return Math.max(1, text == null ? 1 : text.length() / 2);
    }

    /** 取最后一条 user 消息，演示回声只复述用户真正说的话。 */
    private String lastUserText(Map<String, Object> body) {
        String last = "";
        Object messages = body.get("messages");
        if (messages instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> m && "user".equals(String.valueOf(m.get("role")))) {
                    last = String.valueOf(m.get("content"));
                }
            }
        }
        return last.trim();
    }

    private static String tail(String s, int n) {
        if (s == null) return "";
        return s.length() <= n ? s : s.substring(s.length() - n);
    }
}

package com.openfuture.cloud.web;

import com.openfuture.cloud.domain.ApiKeyEntity;
import com.openfuture.cloud.domain.ModelPrice;
import com.openfuture.cloud.repo.ModelPriceRepo;
import com.openfuture.cloud.repo.UserRepo;
import com.openfuture.cloud.service.BillingService;
import com.openfuture.cloud.service.KeyService;
import com.openfuture.cloud.service.ProxyService;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/v1")
public class ProxyController {
    private final ProxyService proxy;
    private final KeyService keys;
    private final UserRepo users;
    private final ModelPriceRepo prices;

    public ProxyController(ProxyService proxy, KeyService keys, UserRepo users, ModelPriceRepo prices) {
        this.proxy = proxy;
        this.keys = keys;
        this.users = users;
        this.prices = prices;
    }

    @GetMapping("/models")
    public Map<String, Object> models() {
        List<Map<String, Object>> data = new ArrayList<>();
        for (ModelPrice p : prices.findByEnabledTrue()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", p.model);
            m.put("object", "model");
            m.put("owned_by", p.vendor == null ? "openfuture" : p.vendor);
            data.add(m);
        }
        if (data.isEmpty()) {
            for (String m : List.of("gpt-4o-mini", "deepseek-chat", "claude-sonnet-4")) {
                data.add(Map.of("id", m, "object", "model", "owned_by", "openfuture"));
            }
        }
        return Map.of("object", "list", "data", data);
    }

    /** OpenAI 兼容的聊天补全：平台密钥鉴权 → 余额预检 → 上游/演示 → 计量扣费。 */
    @PostMapping("/chat/completions")
    public Object chat(@RequestHeader(value = "Authorization", required = false) String auth,
                       @RequestBody Map<String, Object> body,
                       jakarta.servlet.http.HttpServletResponse response) throws Exception {
        String key = auth == null ? null : auth.replaceFirst("(?i)^Bearer\\s+", "").trim();
        ApiKeyEntity k = keys.authenticate(key);
        String model = String.valueOf(body.getOrDefault("model", "gpt-4o-mini"));
        boolean stream = Boolean.TRUE.equals(body.get("stream"));

        // 先做一次余额预检，避免白跑上游
        long balance = users.findById(k.userId).map(u -> u.balanceMicros).orElse(0L);
        if (balance <= 0) {
            throw ApiException.paymentRequired("余额不足，请先在「钱包」里充值或使用兑换码");
        }

        if (stream) {
            response.setContentType("text/event-stream;charset=UTF-8");
            response.setHeader("Cache-Control", "no-cache");
            response.setHeader("X-Accel-Buffering", "no");
        }
        response.setCharacterEncoding("UTF-8");
        return proxy.complete(k.userId, model, body, response, stream);
    }

    @GetMapping("/me")
    public Map<String, Object> me(@RequestHeader(value = "Authorization", required = false) String auth) {
        String key = auth == null ? null : auth.replaceFirst("(?i)^Bearer\\s+", "").trim();
        ApiKeyEntity k = keys.authenticate(key);
        long balance = users.findById(k.userId).map(u -> u.balanceMicros).orElse(0L);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("userId", k.userId);
        out.put("keyPrefix", k.prefix);
        out.put("balanceMicros", balance);
        out.put("balanceYuan", BillingService.yuan(balance));
        out.put("prices", prices.findByEnabledTrue().stream().map(p -> Map.of(
                "model", p.model, "promptPerM", p.promptPerM, "completionPerM", p.completionPerM)).toList());
        return out;
    }
}

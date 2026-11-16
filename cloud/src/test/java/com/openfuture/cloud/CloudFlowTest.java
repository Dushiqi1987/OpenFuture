package com.openfuture.cloud;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * 端到端用例：注册 → 兑换 → 密钥 → 代理调用计费 → 下单支付 → 幂等 → 权限。
 * 一个方法按顺序跑，状态在字段间传递，便于阅读整条链路。
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class CloudFlowTest {
    @Autowired
    MockMvc mvc;
    @Autowired
    ObjectMapper json;

    private String token;
    private String apiKey;

    private JsonNode body(MvcResult r) throws Exception {
        return json.readTree(r.getResponse().getContentAsString());
    }

    private JsonNode authPost(String path, String body, String bearer) throws Exception {
        MvcResult r = mvc.perform(post(path)
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("Authorization", "Bearer " + bearer)
                        .content(body))
                .andExpect(status().is2xxSuccessful())
                .andReturn();
        return body(r);
    }

    @Test
    @Order(1)
    void unauthorizedWithoutToken() throws Exception {
        mvc.perform(get("/api/me")).andExpect(status().isUnauthorized());
    }

    @Test
    @Order(2)
    void registerAndRedeemDemoCode() throws Exception {
        String sms = """
                {"phone":"13800000001"}""";
        mvc.perform(post("/api/auth/sms").contentType(MediaType.APPLICATION_JSON).content(sms))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.devCode").value("123456"));

        JsonNode reg = body(mvc.perform(post("/api/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"phone":"13800000001","code":"123456","password":"secret123","nickname":"测试机主"}"""))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.token").exists())
                .andReturn());
        token = reg.path("token").asText();
        assertThat(token).isNotBlank();

        JsonNode me = body(mvc.perform(get("/api/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andReturn());
        assertThat(me.path("balanceMicros").asLong()).isZero();

        JsonNode wallet = authPost("/api/redeem", """
                {"code":"OF-DEMO-100"}""", token);
        assertThat(wallet.path("balanceMicros").asLong()).isEqualTo(100_000_000L);
    }

    @Test
    @Order(3)
    void createKeyAndProxyCharge() throws Exception {
        authPost("/api/devices/self", """
                {"name":"我的电脑","platform":"windows"}""", token);
        JsonNode key = authPost("/api/keys", """
                {"name":"OpenFuture 桌面端"}""", token);
        apiKey = key.path("key").asText();
        assertThat(apiKey).startsWith("sk-of-");

        JsonNode chat = body(mvc.perform(post("/v1/chat/completions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("Authorization", "Bearer " + apiKey)
                        .content("""
                                {"model":"gpt-4o-mini","messages":[{"role":"user","content":"你好，帮我总结今天的计划"}]}"""))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.choices[0].message.content").exists())
                .andReturn());
        assertThat(chat.path("choices").path(0).path("message").path("content").asText())
                .contains("演示回声");
        assertThat(chat.path("usage").path("total_tokens").asInt()).isPositive();

        JsonNode usage = body(mvc.perform(get("/api/usage?days=7").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andReturn());
        assertThat(usage.path("totals").path("chargedMicros").asLong()).isPositive();
    }

    @Test
    @Order(4)
    void streamingMock() throws Exception {
        mvc.perform(post("/v1/chat/completions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("Authorization", "Bearer " + apiKey)
                        .content("""
                                {"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"流式测试"}]}"""))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith("text/event-stream"))
                .andExpect(content().string(org.hamcrest.Matchers.containsString("data: [DONE]")));
    }

    @Test
    @Order(5)
    void usageReportIsIdempotent() throws Exception {
        String payload = """
                {"model":"gpt-4o-mini","promptTokens":1000,"completionTokens":1000,"requestId":"rid-idem-1"}""";
        JsonNode first = authPost("/api/usage/report", payload, token);
        JsonNode second = authPost("/api/usage/report", payload, token);
        assertThat(second.path("chargedMicros").asLong()).isEqualTo(first.path("chargedMicros").asLong());
        assertThat(second.path("balanceMicros").asLong()).isEqualTo(first.path("balanceMicros").asLong());
        assertThat(first.path("chargedMicros").asLong()).isPositive();
    }

    @Test
    @Order(6)
    void orderAndDevPay() throws Exception {
        long before = body(mvc.perform(get("/api/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andReturn()).path("balanceMicros").asLong();

        JsonNode order = authPost("/api/orders", """
                {"amountCents":5000,"channel":"alipay"}""", token);
        String orderNo = order.path("orderNo").asText();
        assertThat(order.path("amountYuan").asText()).isEqualTo("50.00");

        JsonNode paid = authPost("/api/orders/" + orderNo + "/dev-pay", "{}", token);
        assertThat(paid.path("status").asText()).isEqualTo("PAID");

        long after = body(mvc.perform(get("/api/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andReturn()).path("balanceMicros").asLong();
        assertThat(after - before).isEqualTo(50_000_000L);
    }

    @Test
    @Order(7)
    void adminOverview() throws Exception {
        mvc.perform(get("/api/admin/overview"))
                .andExpect(status().isUnauthorized());
        mvc.perform(get("/api/admin/overview").header("X-Admin-Token", "test-admin"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.users").value(1))
                .andExpect(jsonPath("$.revenueCents").value(5000));
    }
}

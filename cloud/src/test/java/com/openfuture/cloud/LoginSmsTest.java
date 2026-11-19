package com.openfuture.cloud;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class LoginSmsTest {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;

    @Test
    void smsCodeLoginCreatesAccount() throws Exception {
        String phone = "13900002222";
        String sms = mvc.perform(post("/api/auth/sms").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"" + phone + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.devCode").value("123456"))
                .andReturn().getResponse().getContentAsString();
        JsonNode node = json.readTree(sms);

        mvc.perform(post("/api/auth/login-code").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"" + phone + "\",\"code\":\"" + node.get("devCode").asText() + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.token").isNotEmpty())
                .andExpect(jsonPath("$.user.phone").value(phone));
    }

    @Test
    void smsIsRateLimited() throws Exception {
        String phone = "13900003333";
        mvc.perform(post("/api/auth/sms").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"" + phone + "\"}"))
                .andExpect(status().isOk());
        mvc.perform(post("/api/auth/sms").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"" + phone + "\"}"))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("too_many_requests"));
    }

    @Test
    void wrongCodeRejected() throws Exception {
        mvc.perform(post("/api/auth/login-code").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"13900004444\",\"code\":\"000000\"}"))
                .andExpect(status().isBadRequest());
    }
}

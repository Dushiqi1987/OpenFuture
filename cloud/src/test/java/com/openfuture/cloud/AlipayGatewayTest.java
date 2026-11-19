package com.openfuture.cloud;

import com.openfuture.cloud.domain.Order;
import com.openfuture.cloud.service.AlipayGateway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class AlipayGatewayTest {
    static String privateKey;
    static String publicKey;
    static AlipayGateway gateway;

    @BeforeAll
    static void setup() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        KeyPair pair = gen.generateKeyPair();
        privateKey = Base64.getEncoder().encodeToString(pair.getPrivate().getEncoded());
        publicKey = Base64.getEncoder().encodeToString(pair.getPublic().getEncoded());
        gateway = new AlipayGateway("2021000000000000", privateKey, publicKey,
                "https://openapi.alipay.com/gateway.do", "https://example.com/api/pay/notify/alipay", "https://example.com/app.html");
    }

    @Test
    void createPayUrlIsSigned() throws Exception {
        Order o = new Order();
        o.orderNo = "OF202611190001";
        o.amountCents = 990;
        String url = gateway.createPayUrl(o);
        assertTrue(url.startsWith("https://openapi.alipay.com/gateway.do?"));
        assertTrue(url.contains("method=alipay.trade.page.pay"));
        assertTrue(url.contains("total_amount%22%3A%229.90%22"));

        Map<String, String> params = new LinkedHashMap<>();
        for (String pair : url.substring(url.indexOf('?') + 1).split("&")) {
            int i = pair.indexOf('=');
            params.put(URLDecoder.decode(pair.substring(0, i), StandardCharsets.UTF_8),
                    URLDecoder.decode(pair.substring(i + 1), StandardCharsets.UTF_8));
        }
        String sign = params.remove("sign");
        params.remove("sign_type");
        assertNotNull(sign);
        assertTrue(verify(content(params), sign));
        params.put("total_amount", "0.01");
        assertFalse(verify(content(params), sign));
    }

    @Test
    void notifySignatureVerified() throws Exception {
        Map<String, String> notify = new LinkedHashMap<>();
        notify.put("app_id", "2021000000000000");
        notify.put("out_trade_no", "OF202611190001");
        notify.put("total_amount", "9.90");
        notify.put("trade_status", "TRADE_SUCCESS");
        notify.put("notify_time", "2026-11-19 10:00:00");
        notify.put("notify_id", "abc123");
        Signature s = Signature.getInstance("SHA256withRSA");
        s.initSign(java.security.KeyFactory.getInstance("RSA").generatePrivate(
                new java.security.spec.PKCS8EncodedKeySpec(Base64.getDecoder().decode(privateKey))));
        s.update(content(notify).getBytes(StandardCharsets.UTF_8));
        notify.put("sign", Base64.getEncoder().encodeToString(s.sign()));
        notify.put("sign_type", "RSA2");

        assertTrue(gateway.verifyNotify(notify));
        notify.put("total_amount", "0.01");
        assertFalse(gateway.verifyNotify(notify));
        assertEquals(990, AlipayGateway.toCents("9.90"));
    }

    private static String content(Map<String, String> params) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : new java.util.TreeMap<>(params).entrySet()) {
            if ("sign".equals(e.getKey()) || "sign_type".equals(e.getKey())) continue;
            if (sb.length() > 0) sb.append('&');
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        return sb.toString();
    }

    private static boolean verify(String content, String sign) throws Exception {
        Signature v = Signature.getInstance("SHA256withRSA");
        v.initVerify(java.security.KeyFactory.getInstance("RSA").generatePublic(
                new java.security.spec.X509EncodedKeySpec(Base64.getDecoder().decode(publicKey))));
        v.update(content.getBytes(StandardCharsets.UTF_8));
        return v.verify(Base64.getDecoder().decode(sign));
    }
}

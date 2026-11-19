package com.openfuture.cloud.service;

import com.openfuture.cloud.domain.Order;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;

/**
 * 支付宝「电脑网站支付」（alipay.trade.page.pay）。
 * 只依赖平台密钥，不引 SDK：下单时 RSA2 签名拼跳转 URL，异步通知用支付宝公钥验签。
 */
@Component
@ConditionalOnProperty(name = "openfuture.pay.provider", havingValue = "alipay")
public class AlipayGateway implements PayGateway {
    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final String appId;
    private final String privateKey;
    private final String alipayPublicKey;
    private final String gateway;
    private final String notifyUrl;
    private final String returnUrl;

    public AlipayGateway(
            @Value("${openfuture.pay.alipay.app-id:}") String appId,
            @Value("${openfuture.pay.alipay.private-key:}") String privateKey,
            @Value("${openfuture.pay.alipay.public-key:}") String alipayPublicKey,
            @Value("${openfuture.pay.alipay.gateway:https://openapi.alipay.com/gateway.do}") String gateway,
            @Value("${openfuture.pay.alipay.notify-url:}") String notifyUrl,
            @Value("${openfuture.pay.alipay.return-url:}") String returnUrl) {
        this.appId = appId;
        this.privateKey = privateKey;
        this.alipayPublicKey = alipayPublicKey;
        this.gateway = gateway;
        this.notifyUrl = notifyUrl;
        this.returnUrl = returnUrl;
    }

    @Override
    public String name() { return "alipay"; }

    @Override
    public String createPayUrl(Order order) {
        if (appId == null || appId.isBlank() || privateKey == null || privateKey.isBlank()) {
            throw new IllegalStateException("未配置支付宝 app-id / private-key");
        }
        Map<String, String> p = new TreeMap<>();
        p.put("app_id", appId);
        p.put("method", "alipay.trade.page.pay");
        p.put("format", "JSON");
        p.put("charset", "utf-8");
        p.put("sign_type", "RSA2");
        p.put("timestamp", LocalDateTime.now(ZoneId.of("Asia/Shanghai")).format(TS));
        p.put("version", "1.0");
        if (notifyUrl != null && !notifyUrl.isBlank()) p.put("notify_url", notifyUrl);
        if (returnUrl != null && !returnUrl.isBlank()) p.put("return_url", returnUrl);
        String subject = "OpenFuture 余额充值 " + order.orderNo;
        p.put("biz_content", "{\"out_trade_no\":\"" + order.orderNo + "\",\"total_amount\":\""
                + BigDecimal.valueOf(order.amountCents, 2).toPlainString() + "\",\"subject\":\"" + subject
                + "\",\"product_code\":\"FAST_INSTANT_TRADE_PAY\"}");
        p.put("sign", sign(content(p), privateKey));
        StringBuilder url = new StringBuilder(gateway).append('?');
        boolean first = true;
        for (Map.Entry<String, String> e : p.entrySet()) {
            if (!first) url.append('&');
            first = false;
            url.append(enc(e.getKey())).append('=').append(enc(e.getValue()));
        }
        return url.toString();
    }

    /** 异步通知验签：返回 true 表示签名有效（金额/订单号仍需业务校验）。 */
    public boolean verifyNotify(Map<String, String> params) {
        String sign = params.get("sign");
        if (sign == null || alipayPublicKey == null || alipayPublicKey.isBlank()) return false;
        return verify(content(params), sign.replace("\n", "").replace(" ", "+"), alipayPublicKey);
    }

    /** 支付宝通知里的 total_amount 是元，转成分。 */
    public static long toCents(String totalAmount) {
        return new BigDecimal(totalAmount).movePointRight(2).setScale(0, java.math.RoundingMode.UNNECESSARY).longValue();
    }

    private static String content(Map<String, String> params) {
        Map<String, String> sorted = new TreeMap<>();
        for (Map.Entry<String, String> e : params.entrySet()) {
            if ("sign".equals(e.getKey()) || "sign_type".equals(e.getKey())) continue;
            if (e.getValue() == null || e.getValue().isBlank()) continue;
            sorted.put(e.getKey(), e.getValue());
        }
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : sorted.entrySet()) {
            if (sb.length() > 0) sb.append('&');
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        return sb.toString();
    }

    private static String sign(String content, String key) {
        try {
            Signature s = Signature.getInstance("SHA256withRSA");
            s.initSign(loadPrivate(key));
            s.update(content.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(s.sign());
        } catch (Exception e) {
            throw new IllegalStateException("支付宝签名失败：" + e.getMessage(), e);
        }
    }

    private static boolean verify(String content, String sign, String key) {
        try {
            Signature s = Signature.getInstance("SHA256withRSA");
            s.initVerify(loadPublic(key));
            s.update(content.getBytes(StandardCharsets.UTF_8));
            return s.verify(Base64.getDecoder().decode(sign));
        } catch (Exception e) {
            return false;
        }
    }

    private static PrivateKey loadPrivate(String pem) throws Exception {
        String body = pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "")
                .replaceAll("\\s", "");
        return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(body)));
    }

    private static PublicKey loadPublic(String pem) throws Exception {
        String body = pem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "")
                .replaceAll("\\s", "");
        return KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(body)));
    }

    private static String enc(String v) {
        return URLEncoder.encode(v, StandardCharsets.UTF_8).replace("+", "%20");
    }
}

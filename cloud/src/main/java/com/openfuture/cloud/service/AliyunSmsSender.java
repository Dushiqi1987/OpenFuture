package com.openfuture.cloud.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

/**
 * 阿里云短信（dysmsapi 2017-05-25，RPC 签名 HMAC-SHA1）。
 * 需要控制台里已审核通过的签名和模板，模板变量固定为 {"code":"123456"}。
 */
@Component
@ConditionalOnProperty(name = "openfuture.sms.provider", havingValue = "aliyun")
public class AliyunSmsSender implements SmsSender {
    private static final Logger log = LoggerFactory.getLogger(AliyunSmsSender.class);
    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'");

    private final String accessKeyId;
    private final String accessKeySecret;
    private final String signName;
    private final String templateCode;
    private final String endpoint;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(6)).build();

    public AliyunSmsSender(
            @Value("${openfuture.sms.aliyun.access-key-id:}") String accessKeyId,
            @Value("${openfuture.sms.aliyun.access-key-secret:}") String accessKeySecret,
            @Value("${openfuture.sms.aliyun.sign-name:}") String signName,
            @Value("${openfuture.sms.aliyun.template-code:}") String templateCode,
            @Value("${openfuture.sms.aliyun.endpoint:dysmsapi.aliyuncs.com}") String endpoint) {
        this.accessKeyId = accessKeyId;
        this.accessKeySecret = accessKeySecret;
        this.signName = signName;
        this.templateCode = templateCode;
        this.endpoint = endpoint;
    }

    @Override
    public void send(String phone, String code) {
        if (accessKeyId == null || accessKeyId.isBlank() || accessKeySecret == null || accessKeySecret.isBlank()) {
            throw new IllegalStateException("未配置阿里云短信 AccessKey（OF_SMS_AK_ID / OF_SMS_AK_SECRET）");
        }
        try {
            Map<String, String> p = new TreeMap<>();
            p.put("AccessKeyId", accessKeyId);
            p.put("Action", "SendSms");
            p.put("Format", "JSON");
            p.put("PhoneNumbers", phone);
            p.put("RegionId", "cn-hangzhou");
            p.put("SignName", signName);
            p.put("SignatureMethod", "HMAC-SHA1");
            p.put("SignatureNonce", UUID.randomUUID().toString());
            p.put("SignatureVersion", "1.0");
            p.put("TemplateCode", templateCode);
            p.put("TemplateParam", "{\"code\":\"" + code + "\"}");
            p.put("Timestamp", ZonedDateTime.now(ZoneOffset.UTC).format(TS));
            p.put("Version", "2017-05-25");

            StringBuilder canonical = new StringBuilder();
            for (Map.Entry<String, String> e : p.entrySet()) {
                if (canonical.length() > 0) canonical.append('&');
                canonical.append(percent(e.getKey())).append('=').append(percent(e.getValue()));
            }
            String stringToSign = "POST&" + percent("/") + "&" + percent(canonical.toString());
            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec((accessKeySecret + "&").getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
            String signature = Base64.getEncoder().encodeToString(mac.doFinal(stringToSign.getBytes(StandardCharsets.UTF_8)));

            String body = canonical + "&Signature=" + percent(signature);
            HttpRequest req = HttpRequest.newBuilder(URI.create("https://" + endpoint + "/"))
                    .timeout(Duration.ofSeconds(8))
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            log.info("[sms-aliyun] {} status={} body={}", phone, res.statusCode(), res.body());
            if (res.statusCode() / 100 != 2 || !res.body().contains("\"Code\":\"OK\"")) {
                throw new IllegalStateException("短信发送失败：" + res.body());
            }
        } catch (IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("短信发送异常：" + e.getMessage(), e);
        }
    }

    private static String percent(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8)
                .replace("+", "%20").replace("*", "%2A").replace("%7E", "~");
    }
}

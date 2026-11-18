package com.openfuture.cloud.service;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import com.openfuture.cloud.domain.LoginTicket;
import com.openfuture.cloud.domain.User;
import com.openfuture.cloud.repo.LoginTicketRepo;
import com.openfuture.cloud.repo.UserRepo;
import com.openfuture.cloud.security.JwtService;
import com.openfuture.cloud.web.ApiException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * 扫码登录：
 * 1) 电脑端 POST /api/qr/ticket 拿到 ticket / 6 位码 / pollSecret / 二维码图片地址；
 * 2) 手机 App 扫码（打开 openfuture://qr?t=...&b=...）后带着自己的账号 token 调 /api/qr/claim；
 * 3) 电脑端用 pollSecret 轮询 /api/qr/poll，确认后拿到 token。
 */
@Service
public class QrLoginService {
    private static final long TTL_SECONDS = 120;
    private static final int QR_SIZE = 360;

    private final LoginTicketRepo tickets;
    private final UserRepo users;
    private final JwtService jwt;
    private final String publicBase;

    public QrLoginService(LoginTicketRepo tickets, UserRepo users, JwtService jwt,
                          @Value("${openfuture.public-base-url:http://127.0.0.1:8090}") String publicBase) {
        this.tickets = tickets;
        this.users = users;
        this.jwt = jwt;
        this.publicBase = publicBase.endsWith("/") ? publicBase.substring(0, publicBase.length() - 1) : publicBase;
    }

    @Transactional
    public Map<String, Object> create(String deviceName, String phoneBase) {
        String base = safeBase(phoneBase);
        Instant now = Instant.now();
        LoginTicket t = new LoginTicket();
        t.ticket = Crypto.randomHex(16);
        t.pollSecret = Crypto.randomHex(16);
        t.code = uniqueCode(now);
        t.deviceName = trim(deviceName, 64);
        t.publicBase = base;
        t.createdAt = now;
        t.expiresAt = now.plusSeconds(TTL_SECONDS);
        tickets.save(t);

        String deepLink = deepLink(t.ticket, base);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ticket", t.ticket);
        out.put("code", t.code);
        out.put("pollSecret", t.pollSecret);
        out.put("expiresAt", t.expiresAt.toString());
        out.put("expiresInSeconds", TTL_SECONDS);
        out.put("deepLink", deepLink);
        out.put("imageUrl", base + "/api/qr/image/" + t.ticket);
        out.put("claimUrl", base + "/api/qr/claim");
        return out;
    }

    /** 手机端确认登录：ticket 或 6 位码二选一。 */
    @Transactional
    public Map<String, Object> claim(long uid, String ticket, String code) {
        LoginTicket t = find(ticket, code);
        Instant now = Instant.now();
        if (t.used) throw new ApiException(409, "qr_used", "这个二维码已经用过了");
        if (t.expiresAt.isBefore(now)) throw new ApiException(410, "qr_expired", "二维码已过期，请在电脑端刷新");
        if (t.userId != null && !t.userId.equals(uid)) {
            throw new ApiException(409, "qr_taken", "这个二维码已被其他账号确认");
        }
        t.userId = uid;
        tickets.save(t);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("deviceName", t.deviceName);
        out.put("message", "已确认，电脑端马上会登录");
        return out;
    }

    /** 电脑端轮询；第一次拿到 token 后票据作废。 */
    @Transactional
    public Map<String, Object> poll(String ticket, String secret) {
        LoginTicket t = tickets.findByTicket(nz(ticket))
                .orElseThrow(() -> new ApiException(404, "qr_not_found", "二维码不存在，请刷新"));
        if (secret == null || !t.pollSecret.equals(secret)) {
            throw new ApiException(403, "qr_forbidden", "轮询密钥不正确");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        if (t.expiresAt.isBefore(Instant.now()) && t.userId == null) {
            out.put("status", "expired");
            return out;
        }
        if (t.userId == null) {
            out.put("status", "pending");
            return out;
        }
        if (t.used) {
            out.put("status", "used");
            return out;
        }
        User u = users.findById(t.userId).orElseThrow(() -> ApiException.notFound("用户不存在"));
        t.used = true;
        tickets.save(t);
        out.put("status", "claimed");
        out.put("token", jwt.issue(u.id));
        out.put("user", Map.of(
                "id", u.id,
                "phone", u.phone,
                "nickname", u.nickname == null ? "" : u.nickname,
                "balanceMicros", u.balanceMicros));
        return out;
    }

    /** 供二维码图片接口使用：只对未过期的票据出图。 */
    @Transactional(readOnly = true)
    public byte[] png(String ticket) {
        LoginTicket t = tickets.findByTicket(nz(ticket))
                .orElseThrow(() -> new ApiException(404, "qr_not_found", "二维码不存在"));
        if (t.expiresAt.isBefore(Instant.now())) throw new ApiException(410, "qr_expired", "二维码已过期");
        String base = t.publicBase == null || t.publicBase.isBlank() ? publicBase : t.publicBase;
        return render(deepLink(t.ticket, base));
    }

    public String deepLink(String ticket, String base) {
        String encoded = URLEncoder.encode(base, StandardCharsets.UTF_8);
        return "openfuture://qr?t=" + ticket + "&b=" + encoded;
    }

    private String safeBase(String phoneBase) {
        if (phoneBase == null) return publicBase;
        String value = phoneBase.trim().replaceAll("/+$", "");
        if (!value.matches("^https?://[A-Za-z0-9._:\\-]+$")) return publicBase;
        return value;
    }

    private byte[] render(String text) {
        try {
            QRCodeWriter writer = new QRCodeWriter();
            Map<EncodeHintType, Object> hints = new LinkedHashMap<>();
            hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            hints.put(EncodeHintType.MARGIN, 1);
            BitMatrix matrix = writer.encode(text, BarcodeFormat.QR_CODE, QR_SIZE, QR_SIZE, hints);
            int w = matrix.getWidth();
            int h = matrix.getHeight();
            BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    img.setRGB(x, y, matrix.get(x, y) ? 0xFF0F172A : 0xFFFFFFFF);
                }
            }
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            ImageIO.write(img, "PNG", buf);
            return buf.toByteArray();
        } catch (Exception e) {
            throw new IllegalStateException("二维码生成失败", e);
        }
    }

    private LoginTicket find(String ticket, String code) {
        if (ticket != null && !ticket.isBlank()) {
            return tickets.findByTicket(ticket.trim())
                    .orElseThrow(() -> new ApiException(404, "qr_not_found", "二维码不存在"));
        }
        if (code != null && !code.isBlank()) {
            Optional<LoginTicket> found = tickets
                    .findFirstByCodeAndUsedFalseAndExpiresAtAfterOrderByIdDesc(code.trim(), Instant.now());
            return found.orElseThrow(() -> new ApiException(404, "qr_not_found", "验证码不正确或已过期"));
        }
        throw ApiException.badRequest("缺少 ticket 或 code");
    }

    private String uniqueCode(Instant now) {
        for (int i = 0; i < 20; i++) {
            String c = String.format("%06d", (int) (Math.random() * 1_000_000));
            if (tickets.findFirstByCodeAndUsedFalseAndExpiresAtAfterOrderByIdDesc(c, now).isEmpty()) return c;
        }
        return String.format("%06d", (int) (Math.random() * 1_000_000));
    }

    private static String trim(String s, int max) {
        if (s == null) return "";
        String v = s.trim();
        return v.length() <= max ? v : v.substring(0, max);
    }

    private static String nz(String s) {
        return s == null ? "" : s.trim();
    }
}

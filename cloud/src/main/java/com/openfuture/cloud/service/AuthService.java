package com.openfuture.cloud.service;

import com.openfuture.cloud.web.dto.Dtos;
import com.openfuture.cloud.web.ApiException;
import com.openfuture.cloud.domain.User;
import com.openfuture.cloud.repo.UserRepo;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDate;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

import com.openfuture.cloud.security.JwtService;

@Service
public class AuthService {
    private static final Pattern PHONE = Pattern.compile("^1\\d{10}$");
    private static final Map<String, SmsEntry> SMS = new ConcurrentHashMap<>();
    private final UserRepo users;
    private final PasswordEncoder encoder;
    private final JwtService jwt;
    private final boolean devSms;
    private final SmsSender sender;
    /** 最近一次发送时间 / 当日发送次数，防止短信接口被刷。 */
    private final Map<String, Instant> lastSent = new ConcurrentHashMap<>();
    private final Map<String, LocalDate> sentDay = new ConcurrentHashMap<>();
    private final Map<String, Integer> sentToday = new ConcurrentHashMap<>();

    public AuthService(UserRepo users, PasswordEncoder encoder, JwtService jwt, SmsSender sender,
                       @Value("${openfuture.auth.dev-sms:true}") boolean devSms) {
        this.users = users;
        this.encoder = encoder;
        this.jwt = jwt;
        this.sender = sender;
        this.devSms = devSms;
    }

    record SmsEntry(String code, Instant expiresAt) {}

    @Transactional
    public Map<String, Object> register(Dtos.RegisterReq req) {
        String phone = normalize(req.phone());
        if (req.password() == null || req.password().length() < 6) {
            throw ApiException.badRequest("密码至少 6 位");
        }
        if (users.existsByPhone(phone)) {
            throw ApiException.conflict("手机号已注册");
        }
        verifyCode(phone, req.code());
        User u = new User();
        u.phone = phone;
        u.passwordHash = encoder.encode(req.password());
        u.nickname = req.nickname() == null || req.nickname().isBlank() ? "用户" + phone.substring(7) : req.nickname();
        users.save(u);
        return tokenView(u);
    }

    @Transactional(readOnly = true)
    public Map<String, Object> login(Dtos.LoginReq req) {
        String phone = normalize(req.phone());
        User u = users.findByPhone(phone).orElseThrow(() -> ApiException.unauthorized("账号或密码错误"));
        if (!encoder.matches(req.password() == null ? "" : req.password(), u.passwordHash)) {
            throw ApiException.unauthorized("账号或密码错误");
        }
        if (u.banned) throw ApiException.forbidden("账号已被封禁");
        return tokenView(u);
    }

    /** 验证码登录：手机号未注册时自动建号，密码置为随机值（之后可在账户页设置）。 */
    @Transactional
    public Map<String, Object> loginByCode(String phone, String code) {
        String p = normalize(phone);
        verifyCode(p, code);
        User u = users.findByPhone(p).orElseGet(() -> {
            User created = new User();
            created.phone = p;
            created.passwordHash = encoder.encode(Crypto.randomHex(16));
            created.nickname = "用户" + p.substring(7);
            return users.save(created);
        });
        if (u.banned) throw ApiException.forbidden("账号已被封禁");
        return tokenView(u);
    }

    public String sendSmsCode(String phone) {
        String p = normalize(phone);
        Instant now = Instant.now();
        Instant last = lastSent.get(p);
        if (last != null && last.plusSeconds(60).isAfter(now)) {
            throw ApiException.tooMany("发送太频繁，请 60 秒后再试");
        }
        LocalDate today = LocalDate.now();
        if (!today.equals(sentDay.get(p))) {
            sentDay.put(p, today);
            sentToday.put(p, 0);
        }
        int count = sentToday.getOrDefault(p, 0);
        if (count >= 10) throw ApiException.tooMany("今天的短信条数已用完");
        String code = devSms ? "123456" : String.format("%06d", (int) (Math.random() * 1_000_000));
        try {
            sender.send(p, code);
        } catch (IllegalStateException e) {
            throw new ApiException(502, "sms_failed", e.getMessage());
        }
        lastSent.put(p, now);
        sentToday.put(p, count + 1);
        SMS.put(p, new SmsEntry(code, now.plusSeconds(300)));
        // 开发环境把验证码直接返回，方便没有短信服务时联调
        return devSms ? code : null;
    }

    private void verifyCode(String phone, String code) {
        SmsEntry entry = SMS.get(phone);
        if (devSms && "123456".equals(code)) return;
        if (entry == null || entry.expiresAt().isBefore(Instant.now()) || !entry.code().equals(code)) {
            throw ApiException.badRequest("验证码错误或已过期");
        }
        SMS.remove(phone);
    }

    private Map<String, Object> tokenView(User u) {
        return Map.of("token", jwt.issue(u.id), "user", Map.of(
                "id", u.id, "phone", u.phone, "nickname", u.nickname,
                "balanceMicros", u.balanceMicros));
    }

    private String normalize(String phone) {
        String p = phone == null ? "" : phone.trim();
        if (!PHONE.matcher(p).matches()) throw ApiException.badRequest("请输入 11 位手机号");
        return p;
    }
}

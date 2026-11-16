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

    public AuthService(UserRepo users, PasswordEncoder encoder, JwtService jwt,
                       @Value("${openfuture.auth.dev-sms:true}") boolean devSms) {
        this.users = users;
        this.encoder = encoder;
        this.jwt = jwt;
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

    public String sendSmsCode(String phone) {
        String p = normalize(phone);
        String code = devSms ? "123456" : String.format("%06d", (int) (Math.random() * 1_000_000));
        SMS.put(p, new SmsEntry(code, Instant.now().plusSeconds(300)));
        // 真实环境这里调用短信服务；开发环境直接把验证码返回给客户端便于联调
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

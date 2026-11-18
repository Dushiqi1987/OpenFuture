package com.openfuture.cloud.web;

import com.openfuture.cloud.domain.Device;
import com.openfuture.cloud.domain.User;
import com.openfuture.cloud.repo.DeviceRepo;
import com.openfuture.cloud.repo.UserRepo;
import com.openfuture.cloud.security.Ctx;
import com.openfuture.cloud.service.BillingService;
import com.openfuture.cloud.web.dto.Dtos;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;

/** 账户中心：资料、改密码、退出（客户端丢 token 即可，这里返回 ok 便于统一处理）。 */
@RestController
@RequestMapping("/api/account")
public class AccountController {
    private final UserRepo users;
    private final DeviceRepo devices;
    private final PasswordEncoder encoder;

    public AccountController(UserRepo users, DeviceRepo devices, PasswordEncoder encoder) {
        this.users = users;
        this.devices = devices;
        this.encoder = encoder;
    }

    @GetMapping
    public Map<String, Object> account(HttpServletRequest req) {
        User u = users.findById(Ctx.uid(req)).orElseThrow(() -> ApiException.notFound("用户不存在"));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", u.id);
        out.put("phone", u.phone);
        out.put("nickname", u.nickname == null ? "" : u.nickname);
        out.put("email", u.email == null ? "" : u.email);
        out.put("balanceMicros", u.balanceMicros);
        out.put("balanceYuan", BillingService.yuan(u.balanceMicros));
        out.put("createdAt", u.createdAt.toString());
        out.put("deviceCount", devices.findByUserIdOrderByIdDesc(u.id).size());
        out.put("devices", devices.findByUserIdOrderByIdDesc(u.id).stream().map(this::view).toList());
        return out;
    }

    @PutMapping
    @Transactional
    public Map<String, Object> update(HttpServletRequest req, @RequestBody Dtos.AccountUpdateReq body) {
        User u = users.findById(Ctx.uid(req)).orElseThrow(() -> ApiException.notFound("用户不存在"));
        if (body.nickname() != null) {
            String nick = body.nickname().trim();
            if (nick.isEmpty() || nick.length() > 24) throw ApiException.badRequest("昵称长度需在 1-24 个字符");
            u.nickname = nick;
        }
        if (body.email() != null) {
            String email = body.email().trim();
            if (!email.isEmpty() && !email.matches("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")) {
                throw ApiException.badRequest("邮箱格式不正确");
            }
            u.email = email.isEmpty() ? null : email;
        }
        users.save(u);
        return account(req);
    }

    @PostMapping("/password")
    @Transactional
    public Map<String, Object> password(HttpServletRequest req, @RequestBody Dtos.PasswordReq body) {
        User u = users.findById(Ctx.uid(req)).orElseThrow(() -> ApiException.notFound("用户不存在"));
        if (!encoder.matches(body.oldPassword() == null ? "" : body.oldPassword(), u.passwordHash)) {
            throw ApiException.badRequest("原密码不正确");
        }
        String next = body.newPassword() == null ? "" : body.newPassword();
        if (next.length() < 6) throw ApiException.badRequest("新密码至少 6 位");
        u.passwordHash = encoder.encode(next);
        users.save(u);
        return Map.of("ok", true, "message", "密码已更新");
    }

    @PostMapping("/logout")
    public Map<String, Object> logout() {
        return Map.of("ok", true);
    }

    private Map<String, Object> view(Device d) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", d.id);
        m.put("name", d.name);
        m.put("platform", d.platform);
        m.put("kind", d.kind);
        m.put("revoked", d.revoked);
        return m;
    }
}

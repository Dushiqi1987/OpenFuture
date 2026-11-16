package com.openfuture.cloud.web;

import com.openfuture.cloud.domain.Device;
import com.openfuture.cloud.domain.User;
import com.openfuture.cloud.repo.DeviceRepo;
import com.openfuture.cloud.repo.UsageRepo;
import com.openfuture.cloud.repo.UserRepo;
import com.openfuture.cloud.security.Ctx;
import com.openfuture.cloud.service.BillingService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class MeController {
    private final UserRepo users;
    private final DeviceRepo devices;
    private final UsageRepo usages;

    public MeController(UserRepo users, DeviceRepo devices, UsageRepo usages) {
        this.users = users;
        this.devices = devices;
        this.usages = usages;
    }

    @GetMapping("/me")
    public Map<String, Object> me(HttpServletRequest req) {
        long uid = Ctx.uid(req);
        User u = users.findById(uid).orElseThrow(() -> ApiException.notFound("用户不存在"));
        Instant dayStart = LocalDate.now(ZoneId.of("Asia/Shanghai")).atStartOfDay(ZoneId.of("Asia/Shanghai")).toInstant();

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", u.id);
        out.put("phone", u.phone);
        out.put("nickname", u.nickname);
        out.put("balanceMicros", u.balanceMicros);
        out.put("balanceYuan", BillingService.yuan(u.balanceMicros));
        out.put("banned", u.banned);
        out.put("devices", devices.findByUserIdOrderByIdDesc(uid).stream().map(this::deviceView).toList());
        out.put("today", Map.of(
                "promptTokens", usages.sumPrompt(uid, dayStart),
                "completionTokens", usages.sumCompletion(uid, dayStart),
                "chargedMicros", usages.sumCharged(uid, dayStart),
                "chargedYuan", BillingService.yuan(usages.sumCharged(uid, dayStart))));
        return out;
    }

    private Map<String, Object> deviceView(Device d) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", d.id);
        m.put("name", d.name);
        m.put("platform", d.platform);
        m.put("kind", d.kind);
        m.put("revoked", d.revoked);
        m.put("lastSeenAt", d.lastSeenAt == null ? null : d.lastSeenAt.toString());
        return m;
    }
}

package com.openfuture.cloud.service;

import com.openfuture.cloud.domain.Device;
import com.openfuture.cloud.domain.PairCode;
import com.openfuture.cloud.repo.DeviceRepo;
import com.openfuture.cloud.repo.PairCodeRepo;
import com.openfuture.cloud.web.ApiException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

@Service
public class PairingService {
    private static final SecureRandom RANDOM = new SecureRandom();
    private final PairCodeRepo codes;
    private final DeviceRepo devices;

    public PairingService(PairCodeRepo codes, DeviceRepo devices) {
        this.codes = codes;
        this.devices = devices;
    }

    /** 电脑端调用：生成一次性配对码，5 分钟有效。 */
    @Transactional
    public Map<String, Object> createCode(long userId, String hostName) {
        String code;
        do {
            code = String.format("%06d", RANDOM.nextInt(1_000_000));
        } while (codes.findByCode(code).isPresent());

        PairCode pc = new PairCode();
        pc.code = code;
        pc.userId = userId;
        pc.hostName = hostName == null || hostName.isBlank() ? "我的电脑" : hostName;
        pc.expiresAt = Instant.now().plusSeconds(300);
        codes.save(pc);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", code);
        out.put("hostName", pc.hostName);
        out.put("expiresAt", pc.expiresAt.toString());
        out.put("expiresIn", 300);
        return out;
    }

    /** 手机端调用：用配对码把自己登记到同一账号下。 */
    @Transactional
    public Map<String, Object> claim(long userId, String code, String deviceName, String platform) {
        if (code == null || code.isBlank()) throw ApiException.badRequest("请填写配对码");
        PairCode pc = codes.findByCode(code.trim()).orElseThrow(() -> ApiException.notFound("配对码不存在"));
        if (pc.used) throw ApiException.conflict("配对码已被使用");
        if (pc.expiresAt.isBefore(Instant.now())) throw ApiException.badRequest("配对码已过期，请在电脑上重新生成");
        if (!pc.userId.equals(userId)) throw ApiException.forbidden("该配对码属于其他账号");

        pc.used = true;

        Device phone = new Device();
        phone.userId = userId;
        phone.name = deviceName == null || deviceName.isBlank() ? "我的手机" : deviceName.trim();
        phone.platform = platform == null || platform.isBlank() ? "android" : platform.trim();
        phone.kind = "PHONE";
        phone.lastSeenAt = Instant.now();
        devices.save(phone);

        Device host = devices.findFirstByUserIdAndKindAndRevokedFalseOrderByIdDesc(userId, "PC").orElse(null);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("phone", view(phone));
        out.put("host", host == null ? null : view(host));
        out.put("hostHint", "手机与电脑在同一局域网时可直接连接；跨网请用 VPN/隧道");
        return out;
    }

    /** 电脑端登录后登记自身设备（用于在手机上展示「我的电脑」）。 */
    @Transactional
    public Map<String, Object> registerSelf(long userId, String name, String platform) {
        Device pc = devices.findFirstByUserIdAndKindAndRevokedFalseOrderByIdDesc(userId, "PC").orElseGet(Device::new);
        pc.userId = userId;
        pc.kind = "PC";
        pc.name = name == null || name.isBlank() ? "我的电脑" : name.trim();
        pc.platform = platform == null || platform.isBlank() ? "windows" : platform.trim();
        pc.lastSeenAt = Instant.now();
        if (pc.createdAt == null) pc.createdAt = Instant.now();
        devices.save(pc);
        return view(pc);
    }

    public static String serial(Device d) {
        return d.id + ":" + d.name;
    }

    private Map<String, Object> view(Device d) {
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

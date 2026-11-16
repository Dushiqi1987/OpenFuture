package com.openfuture.cloud.web;

import com.openfuture.cloud.domain.Device;
import com.openfuture.cloud.repo.DeviceRepo;
import com.openfuture.cloud.security.Ctx;
import com.openfuture.cloud.service.PairingService;
import com.openfuture.cloud.web.dto.Dtos;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/devices")
public class DeviceController {
    private final DeviceRepo devices;
    private final PairingService pairing;

    public DeviceController(DeviceRepo devices, PairingService pairing) {
        this.devices = devices;
        this.pairing = pairing;
    }

    @GetMapping
    public List<Map<String, Object>> list(HttpServletRequest req) {
        long uid = Ctx.uid(req);
        return devices.findByUserIdOrderByIdDesc(uid).stream().map(this::view).toList();
    }

    /** 电脑端登录后登记自身，手机上就能看到「我的电脑」。 */
    @PostMapping("/self")
    public Map<String, Object> self(HttpServletRequest req, @RequestBody(required = false) Map<String, String> body) {
        long uid = Ctx.uid(req);
        String name = body == null ? null : body.get("name");
        String platform = body == null ? null : body.get("platform");
        return pairing.registerSelf(uid, name, platform);
    }

    @PostMapping("/pair-code")
    public Map<String, Object> pairCode(HttpServletRequest req, @RequestBody(required = false) Dtos.PairCodeReq body) {
        long uid = Ctx.uid(req);
        return pairing.createCode(uid, body == null ? null : body.hostName());
    }

    @PostMapping("/pair")
    public Map<String, Object> pair(HttpServletRequest req, @RequestBody Dtos.PairClaimReq body) {
        long uid = Ctx.uid(req);
        return pairing.claim(uid, body.code(), body.deviceName(), body.platform());
    }

    @PostMapping("/{id}/revoke")
    public Map<String, Object> revoke(HttpServletRequest req, @PathVariable long id) {
        long uid = Ctx.uid(req);
        Device d = devices.findByIdAndUserId(id, uid).orElseThrow(() -> ApiException.notFound("设备不存在"));
        d.revoked = true;
        devices.save(d);
        return view(d);
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

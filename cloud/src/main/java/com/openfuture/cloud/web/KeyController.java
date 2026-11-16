package com.openfuture.cloud.web;

import com.openfuture.cloud.domain.ApiKeyEntity;
import com.openfuture.cloud.repo.ApiKeyRepo;
import com.openfuture.cloud.security.Ctx;
import com.openfuture.cloud.service.KeyService;
import com.openfuture.cloud.web.dto.Dtos;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/keys")
public class KeyController {
    private final ApiKeyRepo keys;
    private final KeyService keyService;

    public KeyController(ApiKeyRepo keys, KeyService keyService) {
        this.keys = keys;
        this.keyService = keyService;
    }

    @PostMapping
    public Map<String, Object> create(HttpServletRequest req, @RequestBody(required = false) Dtos.KeyReq body) {
        return keyService.create(Ctx.uid(req), body == null ? null : body.name());
    }

    @GetMapping
    public List<Map<String, Object>> list(HttpServletRequest req) {
        long uid = Ctx.uid(req);
        return keys.findByUserIdOrderByIdDesc(uid).stream().map(this::view).toList();
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> revoke(HttpServletRequest req, @PathVariable long id) {
        long uid = Ctx.uid(req);
        ApiKeyEntity k = keys.findByIdAndUserId(id, uid).orElseThrow(() -> ApiException.notFound("密钥不存在"));
        k.revoked = true;
        keys.save(k);
        return view(k);
    }

    private Map<String, Object> view(ApiKeyEntity k) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", k.id);
        m.put("prefix", k.prefix);
        m.put("name", k.name);
        m.put("revoked", k.revoked);
        m.put("createdAt", k.createdAt.toString());
        m.put("lastUsedAt", k.lastUsedAt == null ? null : k.lastUsedAt.toString());
        return m;
    }
}

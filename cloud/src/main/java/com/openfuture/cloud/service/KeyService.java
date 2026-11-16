package com.openfuture.cloud.service;

import com.openfuture.cloud.domain.ApiKeyEntity;
import com.openfuture.cloud.repo.ApiKeyRepo;
import com.openfuture.cloud.web.ApiException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

@Service
public class KeyService {
    private final ApiKeyRepo keys;

    public KeyService(ApiKeyRepo keys) {
        this.keys = keys;
    }

    @Transactional
    public Map<String, Object> create(long userId, String name) {
        String raw = "sk-of-" + Crypto.randomHex(24);
        ApiKeyEntity k = new ApiKeyEntity();
        k.userId = userId;
        k.keyHash = Crypto.sha256Hex(raw);
        k.prefix = raw.substring(0, 12);
        k.name = name == null || name.isBlank() ? "默认密钥" : name.trim();
        keys.save(k);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", k.id);
        out.put("key", raw); // 只此一次
        out.put("prefix", k.prefix);
        out.put("notice", "密钥仅显示一次，请保存到 OpenFuture 的模型设置里");
        return out;
    }

    @Transactional
    public ApiKeyEntity authenticate(String bearer) {
        if (bearer == null || !bearer.startsWith("sk-")) {
            throw ApiException.unauthorized("缺少平台密钥（Authorization: Bearer sk-...）");
        }
        ApiKeyEntity k = keys.findByKeyHash(Crypto.sha256Hex(bearer))
                .orElseThrow(() -> ApiException.unauthorized("平台密钥无效"));
        if (k.revoked) throw ApiException.unauthorized("平台密钥已吊销");
        k.lastUsedAt = Instant.now();
        return k;
    }
}

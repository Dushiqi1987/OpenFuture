package com.openfuture.cloud.domain;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "api_key", indexes = @Index(name = "idx_key_hash", columnList = "key_hash", unique = true))
public class ApiKeyEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(name = "user_id", nullable = false)
    public Long userId;

    /** 只存 SHA-256，明文仅在创建时返回一次 */
    @Column(name = "key_hash", unique = true, length = 64, nullable = false)
    public String keyHash;

    @Column(length = 12)
    public String prefix;

    @Column(length = 48)
    public String name;

    public boolean revoked = false;

    @Column(name = "created_at", nullable = false)
    public Instant createdAt = Instant.now();

    @Column(name = "last_used_at")
    public Instant lastUsedAt;
}

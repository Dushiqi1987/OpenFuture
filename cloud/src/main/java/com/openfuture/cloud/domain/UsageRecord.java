package com.openfuture.cloud.domain;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "usage_record", indexes = {
        @Index(name = "idx_usage_user", columnList = "user_id"),
        @Index(name = "idx_usage_req", columnList = "request_id", unique = true)
})
public class UsageRecord {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(name = "user_id", nullable = false)
    public Long userId;

    @Column(length = 64, nullable = false)
    public String model;

    @Column(name = "prompt_tokens", nullable = false)
    public int promptTokens;

    @Column(name = "completion_tokens", nullable = false)
    public int completionTokens;

    @Column(name = "charged_micros", nullable = false)
    public long chargedMicros;

    /** 幂等键，客户端或代理生成 */
    @Column(name = "request_id", length = 64)
    public String requestId;

    /** PROXY / DEVICE_REPORT */
    @Column(length = 16)
    public String source;

    @Column(name = "created_at", nullable = false)
    public Instant createdAt = Instant.now();
}

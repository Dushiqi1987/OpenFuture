package com.openfuture.cloud.domain;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "pair_code", indexes = @Index(name = "idx_pair_code", columnList = "code", unique = true))
public class PairCode {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(unique = true, length = 8, nullable = false)
    public String code;

    @Column(name = "user_id", nullable = false)
    public Long userId;

    @Column(name = "host_name", length = 64)
    public String hostName;

    @Column(name = "expires_at", nullable = false)
    public Instant expiresAt;

    public boolean used = false;

    @Column(name = "created_at", nullable = false)
    public Instant createdAt = Instant.now();
}

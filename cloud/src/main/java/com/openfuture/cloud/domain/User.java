package com.openfuture.cloud.domain;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "app_user", indexes = @Index(name = "idx_user_phone", columnList = "phone", unique = true))
public class User {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(unique = true, length = 32)
    public String phone;

    @Column(length = 128)
    public String email;

    @Column(name = "password_hash", length = 100)
    public String passwordHash;

    @Column(length = 48)
    public String nickname;

    /** 余额，单位：微元（1 元 = 1_000_000） */
    @Column(name = "balance_micros", nullable = false)
    public long balanceMicros = 0;

    public boolean banned = false;

    @Column(name = "created_at", nullable = false)
    public Instant createdAt = Instant.now();
}

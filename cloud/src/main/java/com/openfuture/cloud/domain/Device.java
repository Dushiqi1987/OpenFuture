package com.openfuture.cloud.domain;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "device", indexes = @Index(name = "idx_device_user", columnList = "user_id"))
public class Device {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(name = "user_id", nullable = false)
    public Long userId;

    @Column(length = 64, nullable = false)
    public String name;

    /** android / windows / mac / web */
    @Column(length = 16, nullable = false)
    public String platform;

    /** PC / PHONE */
    @Column(length = 8, nullable = false)
    public String kind;

    public boolean revoked = false;

    @Column(name = "last_seen_at")
    public Instant lastSeenAt;

    @Column(name = "created_at", nullable = false)
    public Instant createdAt = Instant.now();
}

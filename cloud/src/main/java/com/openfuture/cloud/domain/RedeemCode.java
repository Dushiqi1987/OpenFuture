package com.openfuture.cloud.domain;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "redeem_code", indexes = @Index(name = "idx_redeem_code", columnList = "code", unique = true))
public class RedeemCode {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(unique = true, length = 40, nullable = false)
    public String code;

    @Column(name = "amount_micros", nullable = false)
    public long amountMicros;

    @Column(name = "used_by")
    public Long usedBy;

    @Column(name = "used_at")
    public Instant usedAt;

    @Column(name = "created_at", nullable = false)
    public Instant createdAt = Instant.now();
}

package com.openfuture.cloud.domain;

import jakarta.persistence.*;
import java.time.Instant;

/** 余额流水：充值 / 计量扣费 / 兑换码 / 退款 */
@Entity
@Table(name = "ledger_entry", indexes = @Index(name = "idx_ledger_user", columnList = "user_id"))
public class LedgerEntry {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(name = "user_id", nullable = false)
    public Long userId;

    /** 正数为入账，负数为扣费，单位微元 */
    @Column(name = "delta_micros", nullable = false)
    public long deltaMicros;

    @Column(name = "balance_after", nullable = false)
    public long balanceAfter;

    /** ORDER / REDEEM / USAGE / REFUND */
    @Column(length = 16, nullable = false)
    public String kind;

    @Column(name = "ref_id", length = 64)
    public String refId;

    @Column(name = "created_at", nullable = false)
    public Instant createdAt = Instant.now();
}

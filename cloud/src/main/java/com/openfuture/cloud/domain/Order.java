package com.openfuture.cloud.domain;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "orders", indexes = @Index(name = "idx_order_user", columnList = "user_id"))
public class Order {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(name = "order_no", unique = true, length = 40, nullable = false)
    public String orderNo;

    @Column(name = "user_id", nullable = false)
    public Long userId;

    /** 支付金额，单位：分 */
    @Column(name = "amount_cents", nullable = false)
    public long amountCents;

    /** alipay / wechat / mock */
    @Column(length = 16, nullable = false)
    public String channel;

    /** PENDING / PAID / CLOSED */
    @Column(length = 12, nullable = false)
    public String status = "PENDING";

    @Column(name = "credited_micros")
    public Long creditedMicros;

    @Column(name = "created_at", nullable = false)
    public Instant createdAt = Instant.now();

    @Column(name = "paid_at")
    public Instant paidAt;
}

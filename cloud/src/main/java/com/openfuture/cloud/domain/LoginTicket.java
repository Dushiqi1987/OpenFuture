package com.openfuture.cloud.domain;

import jakarta.persistence.*;
import java.time.Instant;

/**
 * 扫码登录票据：
 * 电脑端创建 → 屏幕显示二维码（内含 ticket）→ 手机 App 扫码确认归属 →
 * 电脑端用 pollSecret 轮询换取 token。
 */
@Entity
@Table(name = "login_ticket", indexes = {
        @Index(name = "idx_lt_ticket", columnList = "ticket", unique = true),
        @Index(name = "idx_lt_code", columnList = "code")
})
public class LoginTicket {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(unique = true, length = 64, nullable = false)
    public String ticket;

    /** 6 位手输码，扫码不方便时用 */
    @Column(length = 8, nullable = false)
    public String code;

    @Column(name = "poll_secret", length = 64, nullable = false)
    public String pollSecret;

    /** 确认登录的用户；为空表示还没人扫码 */
    @Column(name = "user_id")
    public Long userId;

    @Column(name = "device_name", length = 64)
    public String deviceName;

    /** 生成二维码时使用的对外地址（手机按这个地址回连） */
    @Column(name = "public_base", length = 200)
    public String publicBase;

    public boolean used = false;

    @Column(name = "expires_at", nullable = false)
    public Instant expiresAt;

    @Column(name = "created_at", nullable = false)
    public Instant createdAt = Instant.now();
}

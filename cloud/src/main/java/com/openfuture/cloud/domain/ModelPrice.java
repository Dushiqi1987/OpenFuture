package com.openfuture.cloud.domain;

import jakarta.persistence.*;

@Entity
@Table(name = "model_price")
public class ModelPrice {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(unique = true, length = 64, nullable = false)
    public String model;

    /** 微元 / 1M 输入 tokens */
    @Column(name = "prompt_per_m", nullable = false)
    public long promptPerM;

    /** 微元 / 1M 输出 tokens */
    @Column(name = "completion_per_m", nullable = false)
    public long completionPerM;

    public boolean enabled = true;

    @Column(length = 32)
    public String vendor;
}

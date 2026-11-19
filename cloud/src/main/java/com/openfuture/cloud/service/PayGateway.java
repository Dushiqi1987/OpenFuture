package com.openfuture.cloud.service;

import com.openfuture.cloud.domain.Order;

/** 支付通道：开发环境返回本地收银台，生产可接支付宝/微信。 */
public interface PayGateway {
    String name();
    String createPayUrl(Order order);
}

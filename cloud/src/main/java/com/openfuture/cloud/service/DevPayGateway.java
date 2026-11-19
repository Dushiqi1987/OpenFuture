package com.openfuture.cloud.service;

import com.openfuture.cloud.domain.Order;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "openfuture.pay.provider", havingValue = "dev", matchIfMissing = true)
public class DevPayGateway implements PayGateway {
    @Override
    public String name() { return "dev"; }

    @Override
    public String createPayUrl(Order order) {
        return "/api/pay/checkout?orderNo=" + order.orderNo;
    }
}

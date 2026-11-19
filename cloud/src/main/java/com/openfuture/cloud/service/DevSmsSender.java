package com.openfuture.cloud.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "openfuture.sms.provider", havingValue = "dev", matchIfMissing = true)
public class DevSmsSender implements SmsSender {
    private static final Logger log = LoggerFactory.getLogger(DevSmsSender.class);

    @Override
    public void send(String phone, String code) {
        log.info("[sms-dev] {} -> {}", phone, code);
    }
}

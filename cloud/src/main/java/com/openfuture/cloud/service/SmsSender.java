package com.openfuture.cloud.service;

/** 短信下发口子：开发环境打日志，生产接阿里云/腾讯云。 */
public interface SmsSender {
    void send(String phone, String code);
}

package com.openfuture.cloud.web.dto;

/** 请求体集合：集中放 record，避免一堆只有两三个字段的文件。 */
public final class Dtos {
    private Dtos() {}

    public record RegisterReq(String phone, String code, String password, String nickname) {}

    public record LoginReq(String phone, String password) {}

    public record SmsReq(String phone) {}

    public record PairCodeReq(String hostName) {}

    public record PairClaimReq(String code, String deviceName, String platform) {}

    public record UsageReportReq(String model, int promptTokens, int completionTokens, String requestId, String source) {}

    public record OrderReq(long amountCents, String channel) {}

    public record NotifyReq(String orderNo, long amountCents, String status, String signature) {}

    public record RedeemReq(String code) {}

    public record KeyReq(String name) {}

    public record PriceReq(String model, long promptPerM, long completionPerM, String vendor, boolean enabled) {}

    public record RedeemGenerateReq(long amountMicros, int count, String prefix) {}

    public record QrTicketReq(String deviceName, String publicBase) {}

    public record QrClaimReq(String ticket, String code) {}

    public record AccountUpdateReq(String nickname, String email) {}

    public record PasswordReq(String oldPassword, String newPassword) {}

    public record AdminUserPatchReq(Boolean banned, String nickname) {}

    public record AdminBalanceReq(long deltaMicros, String note) {}
}

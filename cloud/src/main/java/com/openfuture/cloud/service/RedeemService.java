package com.openfuture.cloud.service;

import com.openfuture.cloud.domain.RedeemCode;
import com.openfuture.cloud.repo.RedeemCodeRepo;
import com.openfuture.cloud.web.ApiException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

@Service
public class RedeemService {
    private final RedeemCodeRepo codes;
    private final BillingService billing;

    public RedeemService(RedeemCodeRepo codes, BillingService billing) {
        this.codes = codes;
        this.billing = billing;
    }

    @Transactional
    public long redeem(long userId, String code) {
        if (code == null || code.isBlank()) throw ApiException.badRequest("请输入兑换码");
        RedeemCode rc = codes.findByCode(code.trim()).orElseThrow(() -> ApiException.notFound("兑换码无效"));
        if (rc.usedBy != null) throw ApiException.conflict("兑换码已被使用");
        rc.usedBy = userId;
        rc.usedAt = Instant.now();
        return billing.credit(userId, rc.amountMicros, "REDEEM", rc.code);
    }
}

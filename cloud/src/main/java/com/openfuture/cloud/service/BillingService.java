package com.openfuture.cloud.service;

import com.openfuture.cloud.domain.LedgerEntry;
import com.openfuture.cloud.domain.ModelPrice;
import com.openfuture.cloud.domain.UsageRecord;
import com.openfuture.cloud.domain.User;
import com.openfuture.cloud.repo.LedgerRepo;
import com.openfuture.cloud.repo.ModelPriceRepo;
import com.openfuture.cloud.repo.UsageRepo;
import com.openfuture.cloud.repo.UserRepo;
import com.openfuture.cloud.web.ApiException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class BillingService {
    private final UserRepo users;
    private final UsageRepo usages;
    private final LedgerRepo ledgers;
    private final ModelPriceRepo prices;
    private final long defaultPromptPerM;
    private final long defaultCompletionPerM;

    public BillingService(UserRepo users, UsageRepo usages, LedgerRepo ledgers, ModelPriceRepo prices,
                          @Value("${openfuture.billing.default-prompt-per-m}") long defaultPromptPerM,
                          @Value("${openfuture.billing.default-completion-per-m}") long defaultCompletionPerM) {
        this.users = users;
        this.usages = usages;
        this.ledgers = ledgers;
        this.prices = prices;
        this.defaultPromptPerM = defaultPromptPerM;
        this.defaultCompletionPerM = defaultCompletionPerM;
    }

    public record ChargeResult(long chargedMicros, long balanceMicros, int promptTokens, int completionTokens) {}

    public record Price(long promptPerM, long completionPerM) {}

    /** 扣费并落用量流水；同一 requestId 重复上报只记一次。 */
    @Transactional
    public ChargeResult charge(long userId, String model, int promptTokens, int completionTokens,
                               String requestId, String source) {
        int prompt = Math.max(0, promptTokens);
        int completion = Math.max(0, completionTokens);
        if (requestId != null && !requestId.isBlank()) {
            var dup = usages.findByRequestId(requestId);
            if (dup.isPresent()) {
                UsageRecord r = dup.get();
                long balance = users.findById(userId).map(u -> u.balanceMicros).orElse(0L);
                return new ChargeResult(r.chargedMicros, balance, r.promptTokens, r.completionTokens);
            }
        }
        Price price = priceOf(model);
        long cost = micros(price.promptPerM(), prompt, price.completionPerM(), completion);
        User user = users.lockById(userId).orElseThrow(() -> ApiException.notFound("用户不存在"));
        if (user.banned) throw ApiException.forbidden("账号已被封禁");
        if (user.balanceMicros < cost) {
            throw ApiException.paymentRequired("余额不足：本次需要 " + yuan(cost) + " 元，当前 " + yuan(user.balanceMicros) + " 元");
        }
        user.balanceMicros -= cost;
        UsageRecord record = new UsageRecord();
        record.userId = userId;
        record.model = model == null || model.isBlank() ? "unknown" : model;
        record.promptTokens = prompt;
        record.completionTokens = completion;
        record.chargedMicros = cost;
        record.requestId = requestId == null || requestId.isBlank() ? null : requestId;
        record.source = source == null ? "REPORT" : source;
        usages.save(record);
        ledgers.save(entry(userId, -cost, user.balanceMicros, "USAGE", requestId));
        return new ChargeResult(cost, user.balanceMicros, prompt, completion);
    }

    /** 入账：充值、兑换码、退款。 */
    @Transactional
    public long credit(long userId, long deltaMicros, String kind, String refId) {
        if (deltaMicros <= 0) throw ApiException.badRequest("入账金额必须大于 0");
        User user = users.lockById(userId).orElseThrow(() -> ApiException.notFound("用户不存在"));
        user.balanceMicros += deltaMicros;
        ledgers.save(entry(userId, deltaMicros, user.balanceMicros, kind, refId));
        return user.balanceMicros;
    }

    /** 管理端人工调整余额：可加可减，但结果不能为负。 */
    @Transactional
    public long adjust(long userId, long deltaMicros, String note) {
        if (deltaMicros == 0) throw ApiException.badRequest("调整金额不能为 0");
        User user = users.lockById(userId).orElseThrow(() -> ApiException.notFound("用户不存在"));
        long next = user.balanceMicros + deltaMicros;
        if (next < 0) throw ApiException.badRequest("调整后余额不能为负数");
        user.balanceMicros = next;
        ledgers.save(entry(userId, deltaMicros, next, "ADJUST", note));
        return next;
    }

    public Price priceOf(String model) {
        return prices.findByModel(model)
                .filter(p -> p.enabled)
                .map(p -> new Price(p.promptPerM, p.completionPerM))
                .orElseGet(() -> new Price(defaultPromptPerM, defaultCompletionPerM));
    }

    public static long micros(long promptPerM, int promptTokens, long completionPerM, int completionTokens) {
        double value = (promptTokens * (double) promptPerM + completionTokens * (double) completionPerM) / 1_000_000d;
        return Math.max(0, Math.round(value));
    }

    public static String yuan(long micros) {
        return java.math.BigDecimal.valueOf(micros, 6).stripTrailingZeros().toPlainString();
    }

    private LedgerEntry entry(long userId, long delta, long balanceAfter, String kind, String refId) {
        LedgerEntry e = new LedgerEntry();
        e.userId = userId;
        e.deltaMicros = delta;
        e.balanceAfter = balanceAfter;
        e.kind = kind;
        e.refId = refId;
        return e;
    }
}

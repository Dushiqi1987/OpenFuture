package com.openfuture.cloud.web;

import com.openfuture.cloud.domain.UsageRecord;
import com.openfuture.cloud.repo.UsageRepo;
import com.openfuture.cloud.security.Ctx;
import com.openfuture.cloud.service.BillingService;
import com.openfuture.cloud.web.dto.Dtos;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/usage")
public class UsageController {
    private final UsageRepo usages;
    private final BillingService billing;

    public UsageController(UsageRepo usages, BillingService billing) {
        this.usages = usages;
        this.billing = billing;
    }

    /** 设备（电脑端）上报一次模型调用的 token 用量，服务端按价格表扣费。 */
    @PostMapping("/report")
    public Map<String, Object> report(HttpServletRequest req, @RequestBody Dtos.UsageReportReq body) {
        long uid = Ctx.uid(req);
        BillingService.ChargeResult r = billing.charge(uid, body.model(),
                body.promptTokens(), body.completionTokens(),
                body.requestId(), body.source() == null ? "DEVICE_REPORT" : body.source());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("chargedMicros", r.chargedMicros());
        out.put("chargedYuan", BillingService.yuan(r.chargedMicros()));
        out.put("balanceMicros", r.balanceMicros());
        out.put("balanceYuan", BillingService.yuan(r.balanceMicros()));
        return out;
    }

    @GetMapping
    public Map<String, Object> list(HttpServletRequest req,
                                    @RequestParam(defaultValue = "7") int days) {
        long uid = Ctx.uid(req);
        Instant from = Instant.now().minus(Math.max(1, Math.min(days, 90)), ChronoUnit.DAYS);
        long charged = usages.sumCharged(uid, from);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("days", days);
        out.put("totals", Map.of(
                "promptTokens", usages.sumPrompt(uid, from),
                "completionTokens", usages.sumCompletion(uid, from),
                "chargedMicros", charged,
                "chargedYuan", BillingService.yuan(charged)));
        out.put("records", usages.findTop50ByUserIdOrderByIdDesc(uid).stream().map(this::view).toList());
        return out;
    }

    private Map<String, Object> view(UsageRecord r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", r.id);
        m.put("model", r.model);
        m.put("promptTokens", r.promptTokens);
        m.put("completionTokens", r.completionTokens);
        m.put("chargedMicros", r.chargedMicros);
        m.put("chargedYuan", BillingService.yuan(r.chargedMicros));
        m.put("source", r.source);
        m.put("createdAt", r.createdAt.toString());
        return m;
    }
}

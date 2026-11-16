package com.openfuture.cloud.web;

import com.openfuture.cloud.domain.ModelPrice;
import com.openfuture.cloud.domain.Order;
import com.openfuture.cloud.domain.RedeemCode;
import com.openfuture.cloud.domain.UsageRecord;
import com.openfuture.cloud.domain.User;
import com.openfuture.cloud.repo.DeviceRepo;
import com.openfuture.cloud.repo.ModelPriceRepo;
import com.openfuture.cloud.repo.OrderRepo;
import com.openfuture.cloud.repo.RedeemCodeRepo;
import com.openfuture.cloud.repo.UsageRepo;
import com.openfuture.cloud.repo.UserRepo;
import com.openfuture.cloud.service.BillingService;
import com.openfuture.cloud.service.Crypto;
import com.openfuture.cloud.web.dto.Dtos;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.PageRequest;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 管理后台接口：用 X-Admin-Token 保护，不走用户 JWT。 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {
    private final UserRepo users;
    private final DeviceRepo devices;
    private final OrderRepo orders;
    private final UsageRepo usages;
    private final ModelPriceRepo prices;
    private final RedeemCodeRepo codes;
    private final String adminToken;

    public AdminController(UserRepo users, DeviceRepo devices, OrderRepo orders, UsageRepo usages,
                           ModelPriceRepo prices, RedeemCodeRepo codes,
                           @Value("${openfuture.admin-token}") String adminToken) {
        this.users = users;
        this.devices = devices;
        this.orders = orders;
        this.usages = usages;
        this.prices = prices;
        this.codes = codes;
        this.adminToken = adminToken;
    }

    private void check(String token) {
        if (token == null || !token.equals(adminToken)) throw ApiException.unauthorized("管理员令牌错误");
    }

    @GetMapping("/overview")
    public Map<String, Object> overview(@RequestHeader(value = "X-Admin-Token", required = false) String token) {
        check(token);
        Instant dayStart = LocalDate.now(ZoneId.of("Asia/Shanghai")).atStartOfDay(ZoneId.of("Asia/Shanghai")).toInstant();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("users", users.count());
        out.put("devices", devices.count());
        out.put("paidOrders", orders.countByStatus("PAID"));
        out.put("revenueCents", orders.sumPaidCents());
        out.put("revenueYuan", java.math.BigDecimal.valueOf(orders.sumPaidCents(), 2).toPlainString());
        out.put("todayRequests", usages.countByCreatedAtAfter(dayStart));
        out.put("todayChargedMicros", usages.sumAllCharged(dayStart));
        out.put("todayChargedYuan", BillingService.yuan(usages.sumAllCharged(dayStart)));
        out.put("unusedRedeemCodes", codes.countByUsedByIsNull());
        return out;
    }

    @GetMapping("/users")
    public List<Map<String, Object>> users(@RequestHeader(value = "X-Admin-Token", required = false) String token,
                                           @RequestParam(defaultValue = "50") int limit) {
        check(token);
        List<Map<String, Object>> out = new ArrayList<>();
        for (User u : users.findAll(PageRequest.of(0, Math.min(200, Math.max(1, limit)))).getContent()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", u.id);
            m.put("phone", u.phone);
            m.put("nickname", u.nickname);
            m.put("balanceMicros", u.balanceMicros);
            m.put("balanceYuan", BillingService.yuan(u.balanceMicros));
            m.put("banned", u.banned);
            m.put("createdAt", u.createdAt.toString());
            out.add(m);
        }
        return out;
    }

    @GetMapping("/orders")
    public List<Map<String, Object>> orders(@RequestHeader(value = "X-Admin-Token", required = false) String token,
                                            @RequestParam(defaultValue = "50") int limit) {
        check(token);
        List<Map<String, Object>> out = new ArrayList<>();
        for (Order o : orders.findAll(PageRequest.of(0, Math.min(200, Math.max(1, limit)))).getContent()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("orderNo", o.orderNo);
            m.put("userId", o.userId);
            m.put("amountCents", o.amountCents);
            m.put("amountYuan", java.math.BigDecimal.valueOf(o.amountCents, 2).toPlainString());
            m.put("channel", o.channel);
            m.put("status", o.status);
            m.put("createdAt", o.createdAt.toString());
            m.put("paidAt", o.paidAt == null ? null : o.paidAt.toString());
            out.add(m);
        }
        return out;
    }

    @GetMapping("/prices")
    public List<ModelPrice> prices(@RequestHeader(value = "X-Admin-Token", required = false) String token) {
        check(token);
        return prices.findAll();
    }

    /** 新增或修改某个模型的价格（微元 / 1M tokens）。 */
    @PutMapping("/prices")
    public ModelPrice price(@RequestHeader(value = "X-Admin-Token", required = false) String token,
                            @RequestBody Dtos.PriceReq req) {
        check(token);
        if (req.model() == null || req.model().isBlank()) throw ApiException.badRequest("model 不能为空");
        ModelPrice p = prices.findByModel(req.model().trim()).orElseGet(ModelPrice::new);
        p.model = req.model().trim();
        p.promptPerM = req.promptPerM();
        p.completionPerM = req.completionPerM();
        p.vendor = req.vendor();
        p.enabled = req.enabled();
        return prices.save(p);
    }

    @GetMapping("/usage")
    public List<UsageRecord> usage(@RequestHeader(value = "X-Admin-Token", required = false) String token,
                                   @RequestParam(defaultValue = "50") int limit) {
        check(token);
        return usages.findAll(PageRequest.of(0, Math.min(500, Math.max(1, limit)))).getContent();
    }

    /** 批量生成兑换码，返回明文（只此一次）。 */
    @PostMapping("/redeem-codes")
    public List<Map<String, Object>> generate(@RequestHeader(value = "X-Admin-Token", required = false) String token,
                                              @RequestBody Dtos.RedeemGenerateReq req) {
        check(token);
        if (req.amountMicros() <= 0) throw ApiException.badRequest("面额必须大于 0");
        int count = Math.max(1, Math.min(200, req.count()));
        String prefix = req.prefix() == null || req.prefix().isBlank() ? "OF" : req.prefix().trim().toUpperCase();
        List<Map<String, Object>> out = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            RedeemCode rc = new RedeemCode();
            rc.code = prefix + "-" + Crypto.randomHex(5).toUpperCase();
            rc.amountMicros = req.amountMicros();
            codes.save(rc);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("code", rc.code);
            m.put("amountMicros", rc.amountMicros);
            m.put("amountYuan", BillingService.yuan(rc.amountMicros));
            out.add(m);
        }
        return out;
    }
}

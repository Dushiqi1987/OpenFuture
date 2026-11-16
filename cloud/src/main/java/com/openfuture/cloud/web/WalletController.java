package com.openfuture.cloud.web;

import com.openfuture.cloud.domain.LedgerEntry;
import com.openfuture.cloud.domain.User;
import com.openfuture.cloud.repo.LedgerRepo;
import com.openfuture.cloud.repo.UserRepo;
import com.openfuture.cloud.security.Ctx;
import com.openfuture.cloud.service.BillingService;
import com.openfuture.cloud.service.RedeemService;
import com.openfuture.cloud.web.dto.Dtos;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class WalletController {
    private final UserRepo users;
    private final LedgerRepo ledgers;
    private final RedeemService redeemService;

    public WalletController(UserRepo users, LedgerRepo ledgers, RedeemService redeemService) {
        this.users = users;
        this.ledgers = ledgers;
        this.redeemService = redeemService;
    }

    @GetMapping("/wallet")
    public Map<String, Object> wallet(HttpServletRequest req) {
        long uid = Ctx.uid(req);
        User u = users.findById(uid).orElseThrow(() -> ApiException.notFound("用户不存在"));
        List<LedgerEntry> list = ledgers.findTop50ByUserIdOrderByIdDesc(uid);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("balanceMicros", u.balanceMicros);
        out.put("balanceYuan", BillingService.yuan(u.balanceMicros));
        out.put("ledger", list.stream().map(e -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", e.id);
            m.put("deltaMicros", e.deltaMicros);
            m.put("deltaYuan", BillingService.yuan(e.deltaMicros));
            m.put("balanceAfter", e.balanceAfter);
            m.put("kind", e.kind);
            m.put("refId", e.refId);
            m.put("createdAt", e.createdAt.toString());
            return m;
        }).toList());
        return out;
    }

    @PostMapping("/redeem")
    public Map<String, Object> redeem(HttpServletRequest req, @RequestBody Dtos.RedeemReq body) {
        long uid = Ctx.uid(req);
        long balance = redeemService.redeem(uid, body.code());
        return Map.of("balanceMicros", balance, "balanceYuan", BillingService.yuan(balance));
    }
}

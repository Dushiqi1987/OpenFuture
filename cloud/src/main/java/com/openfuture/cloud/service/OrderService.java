package com.openfuture.cloud.service;

import com.openfuture.cloud.domain.Order;
import com.openfuture.cloud.repo.OrderRepo;
import com.openfuture.cloud.web.ApiException;
import com.openfuture.cloud.web.dto.Dtos;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.SecureRandom;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;

@Service
public class OrderService {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyyMMddHHmmss");

    private final OrderRepo orders;
    private final BillingService billing;
    private final String paySecret;
    private final boolean devMode;

    public OrderService(OrderRepo orders, BillingService billing,
                        @Value("${openfuture.pay-secret}") String paySecret,
                        @Value("${openfuture.pay.dev-mode:true}") boolean devMode) {
        this.orders = orders;
        this.billing = billing;
        this.paySecret = paySecret;
        this.devMode = devMode;
    }

    @Transactional
    public Map<String, Object> create(long userId, long amountCents, String channel) {
        if (amountCents < 100 || amountCents > 1_000_000) {
            throw ApiException.badRequest("充值金额请限制在 1 ~ 10000 元");
        }
        Order o = new Order();
        o.orderNo = "OF" + LocalDateTime.now().format(TS) + String.format("%04d", RANDOM.nextInt(10_000));
        o.userId = userId;
        o.amountCents = amountCents;
        o.channel = channel == null || channel.isBlank() ? "alipay" : channel;
        orders.save(o);

        Map<String, Object> out = view(o);
        out.put("payUrl", "/api/pay/checkout?orderNo=" + o.orderNo);
        out.put("notice", devMode ? "开发模式可直接调用 /api/orders/{orderNo}/dev-pay 模拟支付成功" : "请接入真实支付回调");
        return out;
    }

    @Transactional
    public Map<String, Object> devPay(long userId, String orderNo) {
        if (!devMode) throw ApiException.forbidden("生产环境已关闭模拟支付");
        Order o = orders.findByOrderNo(orderNo).orElseThrow(() -> ApiException.notFound("订单不存在"));
        if (!o.userId.equals(userId)) throw ApiException.forbidden("无权操作该订单");
        markPaid(o, o.amountCents);
        return view(o);
    }

    /** 支付平台异步回调：验签 → 幂等入账。 */
    @Transactional
    public void notifyPaid(Dtos.NotifyReq req) {
        if (req.orderNo() == null || req.orderNo().isBlank()) throw ApiException.badRequest("缺少 orderNo");
        String sign = signature(req.orderNo(), req.amountCents(), req.status());
        if (!sign.equalsIgnoreCase(String.valueOf(req.signature()))) {
            throw ApiException.forbidden("签名校验失败");
        }
        Order o = orders.findByOrderNo(req.orderNo()).orElseThrow(() -> ApiException.notFound("订单不存在"));
        if (!"PAID".equalsIgnoreCase(req.status())) {
            o.status = "CLOSED";
            return;
        }
        markPaid(o, req.amountCents());
    }

    public String signature(String orderNo, long amountCents, String status) {
        return Crypto.hmacHex(paySecret, orderNo + "|" + amountCents + "|" + status);
    }

    public Map<String, Object> view(Order o) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("orderNo", o.orderNo);
        m.put("amountCents", o.amountCents);
        m.put("amountYuan", java.math.BigDecimal.valueOf(o.amountCents, 2).toPlainString());
        m.put("channel", o.channel);
        m.put("status", o.status);
        m.put("creditedMicros", o.creditedMicros);
        m.put("createdAt", o.createdAt.toString());
        m.put("paidAt", o.paidAt == null ? null : o.paidAt.toString());
        return m;
    }

    private void markPaid(Order o, long paidCents) {
        if ("PAID".equals(o.status)) return; // 幂等
        if (paidCents != o.amountCents) throw ApiException.badRequest("回调金额与订单不一致");
        long micros = o.amountCents * 10_000L; // 1 分 = 10000 微元
        o.status = "PAID";
        o.paidAt = Instant.now();
        o.creditedMicros = micros;
        billing.credit(o.userId, micros, "ORDER", o.orderNo);
    }
}

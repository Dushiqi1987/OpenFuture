package com.openfuture.cloud.web;

import com.openfuture.cloud.domain.Order;
import com.openfuture.cloud.repo.OrderRepo;
import com.openfuture.cloud.service.AlipayGateway;
import com.openfuture.cloud.service.OrderService;
import com.openfuture.cloud.web.dto.Dtos;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/pay")
public class PayController {
    private final OrderRepo orders;
    private final OrderService orderService;
    private final ObjectProvider<AlipayGateway> alipay;

    public PayController(OrderRepo orders, OrderService orderService, ObjectProvider<AlipayGateway> alipay) {
        this.orders = orders;
        this.orderService = orderService;
        this.alipay = alipay;
    }

    /** 收银台信息（真实环境返回支付平台的二维码/跳转地址）。 */
    @GetMapping("/checkout")
    public Map<String, Object> checkout(@RequestParam String orderNo) {
        Order o = orders.findByOrderNo(orderNo).orElseThrow(() -> ApiException.notFound("订单不存在"));
        Map<String, Object> view = orderService.view(o);
        view.put("payHint", "开发模式：POST /api/orders/" + orderNo + "/dev-pay 即可模拟到账；"
                + "生产模式：下单接口返回支付宝跳转地址 payUrl");
        return view;
    }

    /** 支付宝异步通知（application/x-www-form-urlencoded，无需登录，靠 RSA2 验签）。 */
    @PostMapping(value = "/notify/alipay", produces = MediaType.TEXT_PLAIN_VALUE)
    public String alipayNotify(@RequestParam Map<String, String> params) {
        AlipayGateway gateway = alipay.getIfAvailable();
        if (gateway == null) return "failure";
        if (!gateway.verifyNotify(params)) return "failure";
        String orderNo = params.get("out_trade_no");
        String amount = params.get("total_amount");
        String status = params.get("trade_status");
        if (!"TRADE_SUCCESS".equals(status) && !"TRADE_FINISHED".equals(status)) return "success";
        try {
            orderService.alipayPaid(orderNo, amount);
            return "success";
        } catch (RuntimeException e) {
            return "failure";
        }
    }

    /** 支付平台异步回调（无需登录，靠签名校验）。 */
    @PostMapping("/notify")
    public Map<String, Object> notify(@RequestBody Dtos.NotifyReq req) {
        orderService.notifyPaid(req);
        return Map.of("code", "SUCCESS");
    }
}

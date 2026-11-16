package com.openfuture.cloud.web;

import com.openfuture.cloud.domain.Order;
import com.openfuture.cloud.repo.OrderRepo;
import com.openfuture.cloud.service.OrderService;
import com.openfuture.cloud.web.dto.Dtos;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/pay")
public class PayController {
    private final OrderRepo orders;
    private final OrderService orderService;

    public PayController(OrderRepo orders, OrderService orderService) {
        this.orders = orders;
        this.orderService = orderService;
    }

    /** 收银台信息（真实环境返回支付平台的二维码/跳转地址）。 */
    @GetMapping("/checkout")
    public Map<String, Object> checkout(@RequestParam String orderNo) {
        Order o = orders.findByOrderNo(orderNo).orElseThrow(() -> ApiException.notFound("订单不存在"));
        Map<String, Object> view = orderService.view(o);
        view.put("payHint", "自用阶段：POST /api/orders/" + orderNo + "/dev-pay 即可模拟到账；"
                + "接入真实支付后，这里返回支付宝/微信的二维码或跳转链接");
        return view;
    }

    /** 支付平台异步回调（无需登录，靠签名校验）。 */
    @PostMapping("/notify")
    public Map<String, Object> notify(@RequestBody Dtos.NotifyReq req) {
        orderService.notifyPaid(req);
        return Map.of("code", "SUCCESS");
    }
}

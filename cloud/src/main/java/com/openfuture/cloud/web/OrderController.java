package com.openfuture.cloud.web;

import com.openfuture.cloud.domain.Order;
import com.openfuture.cloud.repo.OrderRepo;
import com.openfuture.cloud.security.Ctx;
import com.openfuture.cloud.service.OrderService;
import com.openfuture.cloud.web.dto.Dtos;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
    private final OrderRepo orders;
    private final OrderService orderService;

    public OrderController(OrderRepo orders, OrderService orderService) {
        this.orders = orders;
        this.orderService = orderService;
    }

    @PostMapping
    public Map<String, Object> create(HttpServletRequest req, @RequestBody Dtos.OrderReq body) {
        return orderService.create(Ctx.uid(req), body.amountCents(), body.channel());
    }

    @GetMapping
    public List<Map<String, Object>> list(HttpServletRequest req) {
        long uid = Ctx.uid(req);
        return orders.findByUserIdOrderByIdDesc(uid).stream().map(orderService::view).toList();
    }

    /** 开发模式：模拟支付成功，等价于收到支付平台回调。 */
    @PostMapping("/{orderNo}/dev-pay")
    public Map<String, Object> devPay(HttpServletRequest req, @PathVariable String orderNo) {
        return orderService.devPay(Ctx.uid(req), orderNo);
    }
}

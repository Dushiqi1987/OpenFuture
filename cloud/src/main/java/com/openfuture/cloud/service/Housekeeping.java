package com.openfuture.cloud.service;

import com.openfuture.cloud.domain.LoginTicket;
import com.openfuture.cloud.domain.Order;
import com.openfuture.cloud.repo.LoginTicketRepo;
import com.openfuture.cloud.repo.OrderRepo;
import com.openfuture.cloud.repo.PairCodeRepo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;

/**
 * 每小时维护（默认 3600s）：
 * - 30 分钟未支付的订单自动关闭；
 * - 清理过期扫码票据与配对码；
 * - 打一行汇总日志，方便在后台/日志里看运行状态。
 */
@Component
@ConditionalOnProperty(name = "openfuture.housekeeping.enabled", havingValue = "true", matchIfMissing = true)
public class Housekeeping {
    private static final Logger log = LoggerFactory.getLogger(Housekeeping.class);

    private final OrderRepo orders;
    private final LoginTicketRepo tickets;
    private final PairCodeRepo pairCodes;

    public Housekeeping(OrderRepo orders, LoginTicketRepo tickets, PairCodeRepo pairCodes) {
        this.orders = orders;
        this.tickets = tickets;
        this.pairCodes = pairCodes;
    }

    @Scheduled(
            fixedDelayString = "${openfuture.housekeeping.interval-ms:3600000}",
            initialDelayString = "${openfuture.housekeeping.initial-delay-ms:120000}")
    @Transactional
    public void hourly() {
        Instant now = Instant.now();
        int closed = 0;
        List<Order> stale = orders.findByStatusAndCreatedAtBefore("PENDING", now.minusSeconds(1800));
        for (Order o : stale) {
            o.status = "CLOSED";
            orders.save(o);
            closed++;
        }
        List<LoginTicket> expiredTickets = tickets.findByExpiresAtBefore(now.minusSeconds(3600));
        tickets.deleteAll(expiredTickets);
        pairCodes.deleteByExpiresAtBefore(now.minusSeconds(3600));
        log.info("[housekeeping] closed {} stale order(s), pruned {} login ticket(s)", closed, expiredTickets.size());
    }
}

package com.openfuture.cloud.repo;

import com.openfuture.cloud.domain.Order;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;
import java.util.Optional;

public interface OrderRepo extends JpaRepository<Order, Long> {
    Optional<Order> findByOrderNo(String orderNo);

    List<Order> findByUserIdOrderByIdDesc(Long userId);

    long countByStatus(String status);

    List<com.openfuture.cloud.domain.Order> findByStatusAndCreatedAtBefore(String status, java.time.Instant cutoff);

    @Query("select coalesce(sum(o.amountCents),0) from Order o where o.status = 'PAID'")
    long sumPaidCents();
}

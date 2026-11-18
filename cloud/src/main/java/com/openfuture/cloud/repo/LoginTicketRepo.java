package com.openfuture.cloud.repo;

import com.openfuture.cloud.domain.LoginTicket;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface LoginTicketRepo extends JpaRepository<LoginTicket, Long> {
    Optional<LoginTicket> findByTicket(String ticket);

    Optional<LoginTicket> findFirstByCodeAndUsedFalseAndExpiresAtAfterOrderByIdDesc(String code, Instant now);

    List<LoginTicket> findByExpiresAtBefore(Instant cutoff);
}

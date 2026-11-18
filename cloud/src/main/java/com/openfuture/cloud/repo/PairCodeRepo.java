package com.openfuture.cloud.repo;

import com.openfuture.cloud.domain.PairCode;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.Instant;
import java.util.Optional;

public interface PairCodeRepo extends JpaRepository<PairCode, Long> {
    Optional<PairCode> findByCode(String code);

    long deleteByExpiresAtBefore(Instant cutoff);
}

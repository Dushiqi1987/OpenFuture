package com.openfuture.cloud.repo;

import com.openfuture.cloud.domain.RedeemCode;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface RedeemCodeRepo extends JpaRepository<RedeemCode, Long> {
    Optional<RedeemCode> findByCode(String code);

    long countByUsedByIsNull();
}

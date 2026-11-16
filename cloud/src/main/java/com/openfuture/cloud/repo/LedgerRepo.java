package com.openfuture.cloud.repo;

import com.openfuture.cloud.domain.LedgerEntry;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface LedgerRepo extends JpaRepository<LedgerEntry, Long> {
    List<LedgerEntry> findTop50ByUserIdOrderByIdDesc(Long userId);
}

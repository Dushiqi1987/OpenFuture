package com.openfuture.cloud.repo;

import com.openfuture.cloud.domain.UsageRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface UsageRepo extends JpaRepository<UsageRecord, Long> {
    boolean existsByRequestId(String requestId);

    Optional<UsageRecord> findByRequestId(String requestId);

    List<UsageRecord> findTop50ByUserIdOrderByIdDesc(Long userId);

    @Query("select coalesce(sum(u.chargedMicros),0) from UsageRecord u where u.userId = :uid and u.createdAt >= :from")
    long sumCharged(@Param("uid") Long uid, @Param("from") Instant from);

    @Query("select coalesce(sum(u.promptTokens),0) from UsageRecord u where u.userId = :uid and u.createdAt >= :from")
    long sumPrompt(@Param("uid") Long uid, @Param("from") Instant from);

    @Query("select coalesce(sum(u.completionTokens),0) from UsageRecord u where u.userId = :uid and u.createdAt >= :from")
    long sumCompletion(@Param("uid") Long uid, @Param("from") Instant from);

    @Query("select coalesce(sum(u.chargedMicros),0) from UsageRecord u where u.createdAt >= :from")
    long sumAllCharged(@Param("from") Instant from);

    long countByCreatedAtAfter(Instant from);
}

package com.openfuture.cloud.repo;

import com.openfuture.cloud.domain.ApiKeyEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface ApiKeyRepo extends JpaRepository<ApiKeyEntity, Long> {
    Optional<ApiKeyEntity> findByKeyHash(String keyHash);

    List<ApiKeyEntity> findByUserIdOrderByIdDesc(Long userId);

    Optional<ApiKeyEntity> findByIdAndUserId(Long id, Long userId);
}

package com.openfuture.cloud.repo;

import com.openfuture.cloud.domain.Device;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface DeviceRepo extends JpaRepository<Device, Long> {
    List<Device> findByUserIdOrderByIdDesc(Long userId);

    Optional<Device> findByIdAndUserId(Long id, Long userId);

    Optional<Device> findFirstByUserIdAndKindAndRevokedFalseOrderByIdDesc(Long userId, String kind);
}

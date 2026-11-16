package com.openfuture.cloud.repo;

import com.openfuture.cloud.domain.ModelPrice;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface ModelPriceRepo extends JpaRepository<ModelPrice, Long> {
    Optional<ModelPrice> findByModel(String model);

    List<ModelPrice> findByEnabledTrue();
}

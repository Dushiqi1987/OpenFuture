package com.openfuture.cloud.config;

import com.openfuture.cloud.domain.ModelPrice;
import com.openfuture.cloud.domain.RedeemCode;
import com.openfuture.cloud.repo.ModelPriceRepo;
import com.openfuture.cloud.repo.RedeemCodeRepo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

/** 首次启动灌入价格表和一张 100 元演示兑换码，保证「开箱能跑」。 */
@Component
public class DataSeeder implements CommandLineRunner {
    private static final Logger log = LoggerFactory.getLogger(DataSeeder.class);
    private final ModelPriceRepo prices;
    private final RedeemCodeRepo codes;

    public DataSeeder(ModelPriceRepo prices, RedeemCodeRepo codes) {
        this.prices = prices;
        this.codes = codes;
    }

    @Override
    public void run(String... args) {
        if (prices.count() == 0) {
            seed("gpt-4o-mini", 1_000_000, 4_000_000, "openai");
            seed("gpt-4o", 18_000_000, 72_000_000, "openai");
            seed("deepseek-chat", 1_000_000, 4_000_000, "deepseek");
            seed("claude-sonnet-4", 21_000_000, 105_000_000, "anthropic");
            log.info("已初始化 {} 条模型价格", prices.count());
        }
        if (codes.findByCode("OF-DEMO-100").isEmpty()) {
            RedeemCode rc = new RedeemCode();
            rc.code = "OF-DEMO-100";
            rc.amountMicros = 100_000_000L; // 100 元
            codes.save(rc);
            log.info("已创建演示兑换码 OF-DEMO-100（100 元）");
        }
    }

    private void seed(String model, long promptPerM, long completionPerM, String vendor) {
        ModelPrice p = new ModelPrice();
        p.model = model;
        p.promptPerM = promptPerM;
        p.completionPerM = completionPerM;
        p.vendor = vendor;
        p.enabled = true;
        prices.save(p);
    }
}

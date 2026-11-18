package com.openfuture.cloud.web;

import com.openfuture.cloud.security.Ctx;
import com.openfuture.cloud.service.QrLoginService;
import com.openfuture.cloud.web.dto.Dtos;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/** 扫码登录接口：ticket / poll / image 公开，claim 需要已登录的手机账号。 */
@RestController
@RequestMapping("/api/qr")
public class QrController {
    private final QrLoginService qr;

    public QrController(QrLoginService qr) {
        this.qr = qr;
    }

    @PostMapping("/ticket")
    public Map<String, Object> ticket(@RequestBody(required = false) Dtos.QrTicketReq req) {
        return qr.create(req == null ? null : req.deviceName(), req == null ? null : req.publicBase());
    }

    @GetMapping("/poll")
    public Map<String, Object> poll(@RequestParam String ticket,
                                    @RequestParam(name = "secret", required = false) String secret) {
        return qr.poll(ticket, secret);
    }

    /** 手机 App 扫码后调用：把自己账号绑定到这张票据。 */
    @PostMapping("/claim")
    public Map<String, Object> claim(HttpServletRequest req, @RequestBody Dtos.QrClaimReq body) {
        return qr.claim(Ctx.uid(req), body.ticket(), body.code());
    }

    @GetMapping(value = "/image/{ticket}", produces = MediaType.IMAGE_PNG_VALUE)
    public ResponseEntity<byte[]> image(@PathVariable String ticket) {
        return ResponseEntity.ok()
                .header("Cache-Control", "no-store")
                .contentType(MediaType.IMAGE_PNG)
                .body(qr.png(ticket));
    }
}

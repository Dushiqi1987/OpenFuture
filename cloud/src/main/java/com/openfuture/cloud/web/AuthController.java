package com.openfuture.cloud.web;

import com.openfuture.cloud.service.AuthService;
import com.openfuture.cloud.web.dto.Dtos;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AuthService auth;

    public AuthController(AuthService auth) {
        this.auth = auth;
    }

    @PostMapping("/register")
    public Map<String, Object> register(@RequestBody Dtos.RegisterReq req) {
        return auth.register(req);
    }

    @PostMapping("/login")
    public Map<String, Object> login(@RequestBody Dtos.LoginReq req) {
        return auth.login(req);
    }

    /** 开发模式返回 devCode；生产环境只发短信，不返回。 */
    @PostMapping("/sms")
    public Map<String, Object> sms(@RequestBody Dtos.SmsReq req) {
        String code = auth.sendSmsCode(req.phone());
        return code == null ? Map.of("sent", true) : Map.of("sent", true, "devCode", code);
    }
}

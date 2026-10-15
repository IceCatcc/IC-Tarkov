-- IC Tarkov Web 初始表结构
-- 约定：
--   * mode 为任务模式枚举（pvp / pvps / pve），用户数据一律按 (user_id, mode) 隔离
--   * 所有时间列使用 DATETIME（秒精度，与桌面端日志时间戳格式一致）
--   * 活动流的去重键 event_key 与桌面端 ActivityRow.id 语义对应（如 acc|<任务id>）

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(32)     NOT NULL,
  -- 小写名，仅用于唯一约束，避免 Alice / alice 重名
  username_ci   VARCHAR(32)     NOT NULL,
  password_hash VARCHAR(255)    NOT NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username_ci (username_ci)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 会话：存 token 的 sha256，泄库不直接等于可登录
CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64)        NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME        NOT NULL,
  user_agent VARCHAR(255)    NULL,
  ip         VARCHAR(64)     NULL,
  PRIMARY KEY (token_hash),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 用户设置：web 端只保留 UI 偏好与「查看模式」；日志/截图目录属桌面端本地概念，不再存库
CREATE TABLE IF NOT EXISTS user_settings (
  user_id      BIGINT UNSIGNED NOT NULL,
  ui_prefs     JSON            NOT NULL,
  view_mode    ENUM ('pvp', 'pvps', 'pve') NOT NULL DEFAULT 'pvp',
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 每个模式下的杂项状态（当前所在地图等）
CREATE TABLE IF NOT EXISTS user_mode_state (
  user_id     BIGINT UNSIGNED NOT NULL,
  `mode`      ENUM ('pvp', 'pvps', 'pve') NOT NULL,
  current_map VARCHAR(64)     NULL,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, `mode`),
  CONSTRAINT fk_mode_state_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 任务进度（接取 / 完成时间）
CREATE TABLE IF NOT EXISTS quest_entries (
  user_id      BIGINT UNSIGNED NOT NULL,
  `mode`       ENUM ('pvp', 'pvps', 'pve') NOT NULL,
  quest_id     VARCHAR(64)     NOT NULL,
  accepted_at  DATETIME        NULL,
  completed_at DATETIME        NULL,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, `mode`, quest_id),
  KEY idx_quest_entries_user_mode_completed (user_id, `mode`, completed_at),
  CONSTRAINT fk_quest_entries_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 任务目标的手动打勾（不改任务状态）
CREATE TABLE IF NOT EXISTS quest_objectives_done (
  user_id      BIGINT UNSIGNED NOT NULL,
  `mode`       ENUM ('pvp', 'pvps', 'pve') NOT NULL,
  quest_id     VARCHAR(64)     NOT NULL,
  objective_id VARCHAR(64)     NOT NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, `mode`, quest_id, objective_id),
  CONSTRAINT fk_objectives_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 手动解锁（前置未完成但标记为可接取）
CREATE TABLE IF NOT EXISTS unlocked_quests (
  user_id    BIGINT UNSIGNED NOT NULL,
  `mode`     ENUM ('pvp', 'pvps', 'pve') NOT NULL,
  quest_id   VARCHAR(64)     NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, `mode`, quest_id),
  CONSTRAINT fk_unlocked_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 收藏家已收集物品
CREATE TABLE IF NOT EXISTS collected_items (
  user_id    BIGINT UNSIGNED NOT NULL,
  `mode`     ENUM ('pvp', 'pvps', 'pve') NOT NULL,
  item_id    VARCHAR(64)     NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, `mode`, item_id),
  CONSTRAINT fk_collected_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 活动流（接取 / 完成 / 手动操作）。body 即前端的 text 字段（text 是 SQL 类型名，避开）
CREATE TABLE IF NOT EXISTS activities (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  `mode`     ENUM ('pvp', 'pvps', 'pve') NOT NULL,
  event_key  VARCHAR(160)    NOT NULL,
  ts         DATETIME        NOT NULL,
  kind       ENUM ('accept', 'complete', 'progress') NOT NULL,
  quest_id   VARCHAR(64)     NOT NULL DEFAULT '',
  quest_name VARCHAR(255)    NOT NULL DEFAULT '',
  body       VARCHAR(512)    NOT NULL DEFAULT '',
  wiki       VARCHAR(255)    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_activities_event (user_id, `mode`, event_key),
  KEY idx_activities_user (user_id, `mode`, id DESC),
  CONSTRAINT fk_activities_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 游戏数据（全局共享，不区分用户）：原始 JSON 的缓存清单
CREATE TABLE IF NOT EXISTS game_data_files (
  file        VARCHAR(64)     NOT NULL,
  bytes       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_epoch BIGINT        NOT NULL DEFAULT 0,
  etag        VARCHAR(160)    NOT NULL DEFAULT '',
  PRIMARY KEY (file)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 游戏数据的元信息（版本、上次核对时间等）
CREATE TABLE IF NOT EXISTS game_data_meta (
  k VARCHAR(64)  NOT NULL,
  v VARCHAR(255) NOT NULL,
  PRIMARY KEY (k)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

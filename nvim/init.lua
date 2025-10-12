-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  local lazyrepo = "https://github.com/folke/lazy.nvim.git"
  local out = vim.fn.system({ "git", "clone", "--filter=blob:none", "--branch=stable", lazyrepo, lazypath })
  if vim.v.shell_error ~= 0 then
    vim.api.nvim_echo({
      { "Failed to clone lazy.nvim:\n", "ErrorMsg" },
      { out, "WarningMsg" },
      { "\nPress any key to exit..." },
    }, true, {})
    vim.fn.getchar()
    os.exit(1)
  end
end
vim.opt.rtp:prepend(lazypath)

-- Make sure to setup `mapleader` and `maplocalleader` before
-- loading lazy.nvim so that mappings are correct.
-- This is also a good place to setup other settings (vim.opt)

-- vim.g.mapleader = " "
-- vim.g.maplocalleader = "\\"

--------------------------------------------------------------------------------
-- SETTINGS      SETTINGS       SETTINGS                                      --
--------------------------------------------------------------------------------
VK_TAB_SIZE = 4
vim.opt.tabstop = VK_TAB_SIZE
vim.opt.softtabstop = VK_TAB_SIZE
vim.opt.shiftwidth = VK_TAB_SIZE
vim.opt.expandtab = true

vim.opt.list = true
vim.opt.listchars = "tab:> "

vim.opt.textwidth = 0 -- no hard wrap
vim.opt.wrap = false
-- vim.opt.wrapmargin = 200

vim.opt.number = true
vim.opt.relativenumber = true

vim.opt.signcolumn = "yes:1"

vim.opt.timeoutlen = 250 -- timeout for things like f and ff

-- loads editor config for indent / format settings
-- completely fucks line wrapping - very fucking annoying
vim.g.editorconfig = false -- fuck off

vim.keymap.set("n", "gb", ":e #<CR>")
vim.keymap.set("n", "gB", ":vsp #<CR>")

--------------------------------------------------------------------------------
-- SETTINGS OVER SETTINGS OVER SETTINGS OVER                                  --
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- CUSTOM COMMANDS                                                            --
--------------------------------------------------------------------------------
vim.api.nvim_create_user_command("P4e", function(opts)
  args = opts.args
  if opts.nargs == 0 then
    args = vim.fn.expand("%") -- edit current file
  end
  vim.fn.system(string.format("p4 edit %s", args))
end, {})

vim.api.nvim_create_user_command("P4a", function(opts)
  args = opts.args
  if opts.nargs == 0 then
    args = vim.fn.expand("%") -- edit current file
  end
  vim.fn.system(string.format("p4 add %s", args))
end, {})

--------------------------------------------------------------------------------
-- CUSTOM COMMANDS                                                            --
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- PLUGINS      PLUGINS       PLUGINS                                         --
--------------------------------------------------------------------------------
require("lazy").setup({
  spec = {
    {
      "Shatur/neovim-ayu",
      lazy = false, -- Load immediately
      priority = 1000, -- Ensure it loads before other themes

      config = function()
        require("ayu").setup({
          mirage = false,
          terminal = true,
          overrides = {
            -- Remove background for transparency to work
            Normal = { bg = "None" },
            NormalFloat = { bg = "none" },
            ColorColumn = { bg = "None" },
            -- SignColumn = { bg = "None" },
            Folded = { bg = "None" },
            FoldColumn = { bg = "None" },
            CursorLine = { bg = "None" },
            CursorColumn = { bg = "None" },
            VertSplit = { bg = "None" },
            -- Fix Line Numbers
            LineNr = { fg = "#565B66" },
            Whitespace = { fg = "#636A72" },
            -- CursorLineNr = { fg = "#FFDFB3" },
          },
        })
      end,
    },
    {
      "ibhagwan/fzf-lua",
      dependencies = { "nvim-tree/nvim-web-devicons" },
      opts = {
        files = {
          rg_opts = [[--color=never --hidden --files -g "!.git" -g "!*.generated.h" -g "!*.gen.cpp" -g "!.cache"]],
          fd_opts = [[--color=never --hidden --type f --type l -E .git -E Intermediate -E DerivedDataCache -E '*.uasset' -E .cache ]],
        },
      },
      keys = {
        { "<leader>f", "<cmd>FzfLua files<cr>", desc = "Fuzzy find files" },
        { "<leader>g", "<cmd>FzfLua live_grep<cr>", desc = "Fuzzy grep" },
        { "<leader>b", "<cmd>FzfLua buffers<cr>", desc = "Fuzzy buffers" },

        { "<leader>r", "<cmd>FzfLua lsp_references<cr>", desc = "Fuzzy references" },
        { "<leader>s", "<cmd>FzfLua lsp_document_symbols<cr>", desc = "Fuzzy symbols (document)" },
        { "<leader>a", "<cmd>FzfLua lsp_live_workspace_symbols<cr>", desc = "Fuzzy symbols (all)" },
        { "<leader>c", "<cmd>FzfLua lsp_incoming_calls<cr>", desc = "Fuzzy incoming calls" },
        { "<leader>C", "<cmd>FzfLua lsp_outgoing_calls<cr>", desc = "Fuzzy outgoing calls" },
        { "<leader>dr", "<cmd>FzfLua lsp_document_diagnostics<cr>", desc = "Fuzzy diagnostics" },
      },
    },
    {
      "kylechui/nvim-surround",
      version = "*", -- Use for stability; omit to use `main` branch for the latest features
      event = "VeryLazy",
      config = function()
        require("nvim-surround").setup({
          -- Configuration here, or leave empty to use defaults
        })
      end,
    },
    {
      "nvim-treesitter/nvim-treesitter",
      build = ":TSUpdate",
      config = function()
        local configs = require("nvim-treesitter.configs")
        configs.setup({
          ensure_installed = { "cmake", "cpp", "c_sharp", "rust", "c", "lua", "bash", "markdown" },
          sync_install = false,
          auto_install = true,
          highlight = {
            enable = true,
          },
          indent = {
            enable = false,
          },
        })
      end,
    },
    {
      "williamboman/mason.nvim",
      config = function()
        require("mason").setup()
      end,
    },
    {
      "williamboman/mason-lspconfig.nvim",
      config = function()
        require("mason-lspconfig").setup({
          automatic_enable = true,
          ensure_installed = {
            "clangd",
          },
        })
      end,
    },
    {
      "neovim/nvim-lspconfig",
      lazy = false,
      dependencies = {
        -- main one
        { "ms-jpq/coq_nvim", branch = "coq" },

        -- 9000+ Snippets
        -- { "ms-jpq/coq.artifacts", branch = "artifacts" },

        -- lua & third party sources -- See https://github.com/ms-jpq/coq.thirdparty
        -- Need to **configure separately**
        -- { 'ms-jpq/coq.thirdparty', branch = "3p" }
        -- - shell repl
        -- - nvim lua api
        -- - scientific calculator
        -- - comment banner
        -- - etc
      },
      init = function()
        vim.g.coq_settings = {
          auto_start = "shut-up", -- if you want to start COQ at startup
          -- Your COQ settings here
        }
      end,
      config = function()
        vim.api.nvim_create_autocmd("LspAttach", {
          desc = "LSP Actions",
          callback = function(args)
            vim.keymap.set("n", "K", vim.lsp.buf.hover, { noremap = true, silent = true })
            vim.keymap.set("n", "gd", vim.lsp.buf.definition, { noremap = true, silent = true })
            vim.keymap.set("n", "gD", vim.lsp.buf.declaration, { noremap = true, silent = true })
            vim.keymap.set("n", "<leader>dd", vim.diagnostic.open_float, { noremap = true, silent = true })
            vim.keymap.set("n", "<leader>df", vim.lsp.buf.code_action, { noremap = true, silent = true })
            vim.keymap.set("n", "<leader>h", ":LspClangdSwitchSourceHeader <CR>", { noremap = true, silent = true })
          end,
        })
      end,
    },
    {
      "stevearc/conform.nvim",
      event = { "BufWritePre" },
      cmd = { "ConformInfo" },
      keys = {
        {
          "<leader>ff",
          function()
            require("conform").format({ async = true })
          end,
          mode = "",
          desc = "Format buffer",
        },
      },
      opts = {
        formatters_by_ft = {
          lua = { "stylua" },
          python = { "isort", "black" },
          javascript = { "prettierd", "prettier", stop_after_first = true },
          c = { "clang-format" },
          cpp = { "clang-format" },
        },
        default_format_opts = {
          lsp_format = "fallback",
        },
        format_on_save = { timeout_ms = 500 },
        formatters = {
          shfmt = {
            append_args = { "-i", "2" },
          },
          stylua = {
            append_args = { "--indent-width", "2", "--indent-type", "Spaces" },
          },
          clang_format = {
            append_args = { "--style", "Chromium" },
          },
        },
      },
      init = function()
        -- If you want the formatexpr, here is the place to set it
        vim.o.formatexpr = "v:lua.require'conform'.formatexpr()"
      end,
    },
    {
      "windwp/nvim-autopairs",
      event = "InsertEnter",
      config = true,
    },
    {
      "nmac427/guess-indent.nvim",
      config = function()
        require("guess-indent").setup({})
      end,
    },
  },
  -- Configure any other settings here. See the documentation for more details.
  -- colorscheme that will be used when installing plugins.
  install = {
    colorscheme = { "ayu" },
  },
  -- automatically check for plugin updates
  checker = { enabled = false },
})
--------------------------------------------------------------------------------
-- PLUGINS OVER PLUGINS OVER PLUGINS OVER                                     --
--------------------------------------------------------------------------------

vim.cmd.colorscheme("ayu")
